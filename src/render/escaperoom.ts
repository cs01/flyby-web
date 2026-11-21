// The room the escape starts in: the bakery's mill room or a cell of the
// Lupanar, built inside the house's own footprint with a doorway onto the
// street. The town's mesh (render/pompeiimesh.ts) builds houses as solids
// with no inside, so the room is drawn here, on top of it: from inside the
// solid's outward faces are culled and this room is all there is; from the
// street a dark doorway is laid over the frontage where the room opens.
//
// The room is a town Store drawn with the town's own material, so its
// plaster, timber, stone and lava take the town's lighting, shadows, oil
// lamps and pumice like any house front.
//
// It also keeps the walker in: inside the room the town's collision (which
// would push them out through the nearest wall) is replaced by these walls,
// with the doorway as the one way out.

import * as THREE from "three";
import { Store, Surf } from "./pompeiimesh";
import { dome, lathe, mill, tube, type V3 } from "./pompeiiorders";
import { pompeiiMaterial, type PompeiiUniforms } from "./pompeii";
import { SHADOW_CASTER_LAYER } from "./sunshadow";

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

/** What the room is drawn with: the town's uniforms, and the town ground it must clear. */
export interface RoomLook {
  uniforms: PompeiiUniforms | null;
  /** Highest town surface (street, pavement, block slab) at a point. */
  floorAt?: (x: number, z: number) => number;
  lean?: boolean;
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

type RGB = [number, number, number];
type UV = [number, number, number, number];
const NO: UV = [0, 0, 0, 0];

/** The room's surfaces, in room space: a along the frontage from its middle, b inward, y up from the floor. */
class RoomBuilder {
  readonly st = new Store();
  constructor(private readonly p: RoomPlan) {}

  P(a: number, b: number, y: number): V3 {
    const p = this.p;
    return [p.mx + p.ux * a + p.nx * b, p.floorY + y, p.mz + p.uz * a + p.nz * b];
  }

  /** Room-space direction (da, db, dy) to world. */
  D(da: number, db: number, dy: number): V3 {
    const p = this.p;
    return [p.ux * da + p.nx * db, dy, p.uz * da + p.nz * db];
  }

  /** A planar convex polygon, wound to face `facing` (the town draws single-sided). */
  poly(pts: V3[], facing: V3, c: RGB, seed: number, s: Surf, p1: number, p2: number, uvs: UV[]): void {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 1; k + 1 < pts.length && nx * nx + ny * ny + nz * nz < 1e-12; k++) {
      const a = pts[0], b = pts[k], d = pts[k + 1];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
    }
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;
    nx /= L; ny /= L; nz /= L;
    const flip = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const base = this.st.n;
    pts.forEach((q, k) => this.st.vert(q, [nx, ny, nz], c, seed, s, p1, p2, uvs[k] ?? NO));
    for (let k = 1; k + 1 < pts.length; k++) {
      if (flip) this.st.tri(base, base + k + 1, base + k); else this.st.tri(base, base + k, base + k + 1);
    }
  }

  /**
   * An upright quad from (a0, b0) to (a1, b1), y0..y1, facing room-space
   * (fa, fb). u runs from u0 along it, h is the height over the floor, so
   * the plaster's socle and the planks sit right.
   */
  wall(a0: number, b0: number, a1: number, b1: number, y0: number, y1: number, fa: number, fb: number, c: RGB, seed: number, s: Surf, p1 = 0, p2 = 0, u0 = 0, len = 0, H = WALL_H): void {
    const L = Math.hypot(a1 - a0, b1 - b0);
    if (L < 0.01 || y1 - y0 < 0.01) return;
    this.poly([this.P(a0, b0, y0), this.P(a1, b1, y0), this.P(a1, b1, y1), this.P(a0, b0, y1)], this.D(fa, fb, 0), c, seed, s, p1, p2,
      [[u0, y0, len || L, H], [u0 + L, y0, len || L, H], [u0 + L, y1, len || L, H], [u0, y1, len || L, H]]);
  }

  /** A level quad at height y, facing up (dir 1) or down (-1). */
  flat(a0: number, a1: number, b0: number, b1: number, y: number, dir: number, c: RGB, seed: number, s: Surf, p1 = 0, p2 = 0): void {
    const pts = [this.P(a0, b0, y), this.P(a1, b0, y), this.P(a1, b1, y), this.P(a0, b1, y)];
    this.poly(pts, [0, dir, 0], c, seed, s, p1, p2, pts.map((q): UV => [q[0], q[2], 0, 0]));
  }

  /** A box, its four sides and top; `skip` drops faces: 1 front (-b), 2 back (+b), 4 left (-a), 8 right (+a), 16 top. */
  box(a0: number, a1: number, b0: number, b1: number, y0: number, y1: number, c: RGB, seed: number, s: Surf, opt: { skip?: number; top?: Surf; topC?: RGB; p1?: number; p2?: number; bottom?: boolean } = {}): void {
    const k = opt.skip ?? 0, p1 = opt.p1 ?? 0, p2 = opt.p2 ?? 0;
    if (!(k & 1)) this.wall(a0, b0, a1, b0, y0, y1, 0, -1, c, seed, s, p1, p2, 0, 0, y1);
    if (!(k & 2)) this.wall(a1, b1, a0, b1, y0, y1, 0, 1, c, seed, s, p1, p2, 0, 0, y1);
    if (!(k & 4)) this.wall(a0, b1, a0, b0, y0, y1, -1, 0, c, seed, s, p1, p2, 0, 0, y1);
    if (!(k & 8)) this.wall(a1, b0, a1, b1, y0, y1, 1, 0, c, seed, s, p1, p2, 0, 0, y1);
    if (!(k & 16)) this.flat(a0, a1, b0, b1, y1, 1, opt.topC ?? c, seed, opt.top ?? s);
    if (opt.bottom) this.flat(a0, a1, b0, b1, y0, -1, c, seed, s);
  }

  /** The Store seen through a lean: what is drawn about c has its top tipped `ang` toward room (da, db). */
  leaning(c: V3, da: number, db: number, ang: number): Store {
    const [dx, , dz] = this.D(da, db, 0);
    const cs = Math.cos(ang), sn = Math.sin(ang), kx = dz, kz = -dx;
    const rot = (x: number, y: number, z: number): V3 => {
      const d = kx * x + kz * z;
      return [x * cs - kz * y * sn + kx * d * (1 - cs), y * cs + (kz * x - kx * z) * sn, z * cs + kx * y * sn + kz * d * (1 - cs)];
    };
    const st = this.st;
    return {
      get n() { return st.n; },
      vert: (q: V3, n: V3, col: RGB, seed: number, s: Surf, p1: number, p2: number, w: UV) => {
        const r = rot(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
        return st.vert([r[0] + c[0], r[1] + c[1], r[2] + c[2]], rot(n[0], n[1], n[2]), col, seed, s, p1, p2, w);
      },
      tri: (a: number, b: number, d: number) => st.tri(a, b, d),
    } as unknown as Store;
  }
}

const PLASTER: RGB = [0.86, 0.8, 0.68];
const WOOD: RGB = [0.4, 0.28, 0.17];
const BEAM: RGB = [0.3, 0.2, 0.12];
const TUFF: RGB = [0.6, 0.56, 0.46];
const BRICK: RGB = [0.58, 0.34, 0.24];
const CLAY: RGB = [0.66, 0.4, 0.26];

export class EscapeRoom {
  readonly group = new THREE.Group();

  constructor(readonly plan: RoomPlan, kind: RoomKind, look: RoomLook = { uniforms: null }) {
    const p = plan;
    const hw = p.width / 2, d = p.depth;
    // Clear the town's ground under the room: the block slab stands a kerb
    // and a step over the bare terrain the plan was measured on, and on a
    // slope more, so the street paving and the garden showed through.
    if (look.floorAt) {
      let top = -Infinity;
      for (let a = -hw - T; a <= hw + T + 1e-6; a += 0.5) for (let b = -T; b <= d + T + 1e-6; b += 0.5) {
        const x = p.mx + p.ux * a + p.nx * b, z = p.mz + p.uz * a + p.nz * b;
        top = Math.max(top, look.floorAt(x, z));
      }
      if (Number.isFinite(top)) p.floorY = Math.max(p.floorY, top + 0.04);
    }
    const R = new RoomBuilder(p);
    this.build(R, kind, !!look.lean);
    if (look.uniforms) {
      const st = R.st;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(st.pos.slice(0, st.n * 3), 3));
      g.setAttribute("aNormal", new THREE.BufferAttribute(st.nrm.slice(0, st.n * 4), 4, true));
      g.setAttribute("aColour", new THREE.BufferAttribute(st.col.slice(0, st.n * 4), 4, true));
      g.setAttribute("aSurf", new THREE.BufferAttribute(st.surf.slice(0, st.n * 4), 4, false));
      g.setAttribute("aWall", new THREE.BufferAttribute(st.wall.slice(0, st.n * 4), 4));
      g.setIndex(new THREE.BufferAttribute(st.idx.slice(0, st.ni), 1));
      g.computeBoundingSphere();
      // The town stops drawing inside the room's box (its shop and door
      // recesses reach in); the room itself is drawn with that switched off.
      const u = look.uniforms;
      const sign = p.nx * -p.uz + p.nz * p.ux > 0 ? 1 : -1;
      u.uRoomCutA.value.set(p.mx, p.mz, p.ux, p.uz);
      u.uRoomCutB.value.set(hw, sign * d, p.floorY, 1);
      this.cut = u;
      const mesh = new THREE.Mesh(g, pompeiiMaterial({ ...u, uRoomCutB: { value: new THREE.Vector4() } }));
      mesh.name = "escape-room";
      mesh.layers.enable(SHADOW_CASTER_LAYER);
      this.triangles = st.ni / 3;
      this.group.add(mesh);
    }
    // From the street: the open doorway, a dark rectangle just proud of the house front.
    const door = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H), new THREE.MeshBasicMaterial({ color: 0x060403 }));
    door.position.set(p.mx - p.nx * (T + 0.04), p.floorY + DOOR_H / 2, p.mz - p.nz * (T + 0.04));
    door.lookAt(door.position.x - p.nx, door.position.y, door.position.z - p.nz);
    door.name = "escape-doorway";
    this.group.add(door);
    this.group.name = "escape-room";
  }

  /** Triangles in the room's mesh, for the budget. */
  triangles = 0;

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

  private cut: PompeiiUniforms | null = null;

  dispose(): void {
    this.cut?.uRoomCutB.value.set(0, 0, 0, 0);
    this.cut = null;
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    });
  }

  private build(R: RoomBuilder, kind: RoomKind, lean: boolean): void {
    const p = this.plan, hw = p.width / 2, d = p.depth, s = 0.37;
    const bakery = kind === "bakery";
    // Walls: pale plaster over a dark socle (style 0, a house's inner wall),
    // u and h in the wall's own metres so the shader can lay the scheme out.
    const wallC: RGB = bakery ? PLASTER : [0.88, 0.84, 0.76];
    const pw = (a0: number, b0: number, a1: number, b1: number, y0: number, y1: number, fa: number, fb: number, u0 = 0): void =>
      R.wall(a0, b0, a1, b1, y0, y1, fa, fb, wallC, s, Surf.Plaster, 36, 255, u0, 0, WALL_H);
    pw(hw, d, -hw, d, 0, WALL_H, 0, -1);
    pw(-hw, d, -hw, 0, 0, WALL_H, 1, 0);
    pw(hw, 0, hw, d, 0, WALL_H, -1, 0);
    // The front wall: the doorway, and a small high window toward the street.
    const dw = DOOR_W / 2;
    pw(-hw, 0, -dw, 0, 0, WALL_H, 0, 1);
    pw(-dw, 0, dw, 0, DOOR_H + 0.25, WALL_H, 0, 1, hw - dw);
    const wa0 = dw + 0.7, wa1 = Math.min(hw - 0.3, wa0 + 0.6), wy0 = 2.15, wy1 = 2.75;
    if (wa1 - wa0 > 0.4) {
      pw(dw, 0, wa0, 0, 0, WALL_H, 0, 1);
      pw(wa0, 0, wa1, 0, 0, wy0, 0, 1);
      pw(wa0, 0, wa1, 0, wy1, WALL_H, 0, 1);
      pw(wa1, 0, hw, 0, 0, WALL_H, 0, 1);
      // Its reveals, splayed a little, and a stone sill.
      R.wall(wa0, 0, wa0, -T, wy0, wy1, 1, 0, wallC, s, Surf.Plaster, 0, 255);
      R.wall(wa1, -T, wa1, 0, wy0, wy1, -1, 0, wallC, s, Surf.Plaster, 0, 255);
      R.flat(wa0, wa1, -T, 0, wy1, -1, wallC, s, Surf.Plaster);
      R.box(wa0 - 0.05, wa1 + 0.05, -T, 0.06, wy0 - 0.06, wy0, TUFF, s, Surf.Kerb);
      // Iron bars across it.
      for (let a = wa0 + 0.15; a < wa1 - 0.1; a += 0.15) R.box(a - 0.012, a + 0.012, -0.14, -0.11, wy0, wy1, [0.12, 0.11, 0.1], s, Surf.Wood, { skip: 16 });
    } else pw(dw, 0, hw, 0, 0, WALL_H, 0, 1);
    // The doorway: tuff jambs through the wall's thickness, a timber lintel, a raised sill.
    R.wall(-dw, 0, -dw, -T, 0, DOOR_H, 1, 0, TUFF, s, Surf.Kerb);
    R.wall(dw, -T, dw, 0, 0, DOOR_H, -1, 0, TUFF, s, Surf.Kerb);
    R.box(-dw - 0.12, dw + 0.12, -T - 0.02, 0.08, DOOR_H, DOOR_H + 0.25, BEAM, s, Surf.Wood, { bottom: true, skip: 16 });
    R.box(-dw, dw, -T, 0.08, -0.15, 0.06, [0.36, 0.34, 0.32], s, Surf.Kerb);
    // Floor, and a beamed ceiling of boards.
    R.flat(-hw, hw, 0, d, 0, 1, bakery ? [0.56, 0.42, 0.34] : [0.6, 0.5, 0.4], s, Surf.Pavement);
    R.flat(-hw, hw, 0, d, WALL_H, -1, [0.44, 0.32, 0.2], s, Surf.Wood);
    for (let b = 0.5; b < d - 0.2; b += 1.0) R.box(-hw, hw, b - 0.09, b + 0.09, WALL_H - 0.22, WALL_H, BEAM, s, Surf.Wood, { skip: 4 | 8 | 16, bottom: true });

    // The lamp the mission sends you for stands on a masonry ledge against
    // the back wall (app/escape.ts puts it a metre up there), a niche over it.
    const lampA = bakery ? hw - 2.6 : hw - 0.8;
    R.box(lampA - 0.4, lampA + 0.4, d - 0.5, d, 0, 0.94, TUFF, s, Surf.Kerb, { skip: 2 });
    R.box(lampA - 0.45, lampA + 0.45, d - 0.55, d, 0.94, 0.98, TUFF, s, Surf.Kerb, { skip: 2, bottom: true });
    // The niche: a shallow arched recess, its back dark with lamp smoke.
    const nicheY = 1.35;
    R.poly([R.P(lampA - 0.25, d - 0.01, nicheY), R.P(lampA + 0.25, d - 0.01, nicheY), R.P(lampA + 0.25, d - 0.01, nicheY + 0.4),
      R.P(lampA + 0.18, d - 0.01, nicheY + 0.52), R.P(lampA, d - 0.01, nicheY + 0.57), R.P(lampA - 0.18, d - 0.01, nicheY + 0.52), R.P(lampA - 0.25, d - 0.01, nicheY + 0.4)],
      R.D(0, -1, 0), [0.22, 0.16, 0.12], s, Surf.Interior, 0, 0, [NO, NO, NO, NO, NO, NO, NO]);

    if (bakery) this.bakery(R, hw, d, lampA, lean);
    else this.lupanar(R, hw, d);
  }

  private bakery(R: RoomBuilder, hw: number, d: number, lampA: number, lean: boolean): void {
    const s = 0.53;
    // The oven in the back right corner: a masonry block, the brick dome on
    // it, an arched mouth with its smoke hood and flue. The 81 carbonised
    // loaves of Modestus's bakery were found in its chamber.
    const oa0 = Math.max(lampA + 0.5, hw - 2.0), oa1 = hw, ob0 = Math.max(d - 2.0, 1.4), ob1 = d;
    const om = (oa0 + oa1) / 2, ow = oa1 - oa0;
    R.box(oa0, oa1, ob0, ob1, 0, 1.0, [0.64, 0.58, 0.48], s, Surf.Masonry, { skip: 2 | 8, top: Surf.Pavement, topC: [0.5, 0.4, 0.32] });
    const dc = R.P(om, (ob0 + ob1) / 2 + 0.1, 1.0);
    // dome() scales in world axes, so it is round in plan: sized to the smaller side.
    const r = Math.min(ow, ob1 - ob0) * 0.46;
    // Brick under a lime wash: the speckled finish reads at any size, where
    // the masonry pattern's stones came out a metre across on the lathe's u.
    dome(R.st, dc, r, 0.8, r, BRICK, s, Surf.Pavement, 0, Math.PI / 2, lean ? 10 : 14, lean ? 3 : 5);
    // The mouth wall in front of the dome, the arch dark inside.
    const fb = ob0 - 0.02, ma0 = om - 0.55, ma1 = om + 0.55;
    R.box(ma0, ma1, fb, ob0 + 0.35, 1.0, 1.75, BRICK, s, Surf.Masonry, { skip: 2 });
    const arch: V3[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = Math.PI * (k / 8);
      arch.push(R.P(om + Math.cos(t) * 0.3, fb - 0.005, 1.28 + Math.sin(t) * 0.25));
    }
    arch.push(R.P(om - 0.3, fb - 0.005, 1.02), R.P(om + 0.3, fb - 0.005, 1.02));
    R.poly([arch[arch.length - 1], ...arch.slice(0, 9), arch[arch.length - 2]], R.D(0, -1, 0), [0.04, 0.03, 0.03], s, Surf.Interior, 0, 0, arch.map(() => NO));
    // The hood over the mouth, narrowing to the flue up through the ceiling.
    const hy0 = 1.75, hy1 = 2.5;
    const H = (a: number, b: number, y: number): V3 => R.P(a, b, y);
    const lo = [H(ma0, fb, hy0), H(ma1, fb, hy0), H(ma1, ob0 + 0.6, hy0), H(ma0, ob0 + 0.6, hy0)];
    const hi = [H(om - 0.25, ob0 + 0.2, hy1), H(om + 0.25, ob0 + 0.2, hy1), H(om + 0.25, ob0 + 0.6, hy1), H(om - 0.25, ob0 + 0.6, hy1)];
    const sootC: RGB = [0.5, 0.44, 0.38];
    R.poly([lo[0], lo[1], hi[1], hi[0]], R.D(0, -1, 0.6), sootC, s, Surf.Masonry, 0, 0, [NO, NO, NO, NO]);
    R.poly([lo[1], lo[2], hi[2], hi[1]], R.D(1, 0, 0.6), sootC, s, Surf.Masonry, 0, 0, [NO, NO, NO, NO]);
    R.poly([lo[3], lo[0], hi[0], hi[3]], R.D(-1, 0, 0.6), sootC, s, Surf.Masonry, 0, 0, [NO, NO, NO, NO]);
    R.poly(lo, [0, -1, 0], [0.18, 0.15, 0.13], s, Surf.Masonry, 0, 0, [NO, NO, NO, NO]);
    R.box(om - 0.25, om + 0.25, ob0 + 0.2, ob0 + 0.6, hy1, WALL_H, sootC, s, Surf.Masonry, { skip: 16 });

    // Hourglass donkey mills down the left side: lava meta and catillus on a
    // masonry base, the lever beam through the waist. Clear of the middle,
    // where the story puts you.
    const millA = -hw + 1.0;
    if (millA <= -1.15) {
      for (const b of [d - 1.15, d - 3.15]) {
        if (b < 1.0) continue;
        const [x, y, z] = R.P(millA, b, 0);
        const yaw = Math.atan2(R.D(0, 1, 0)[2], R.D(0, 1, 0)[0]) + (b > d - 2 ? 0.4 : -0.3);
        mill(R.st, x, y, z, yaw, s, lean);
      }
    }
    // A rack of loaves by the door: two shelves of round loaves scored in eight.
    const ra0 = -hw, ra1 = -hw + 0.42, rb0 = 0.35, rb1 = Math.min(1.75, d - 2.4);
    if (rb1 - rb0 > 0.6) {
      for (const y of [0.85, 1.45]) {
        R.box(ra0, ra1, rb0, rb1, y - 0.04, y, WOOD, s, Surf.Wood, { skip: 4, bottom: true });
        for (let b = rb0 + 0.17; b < rb1 - 0.12; b += 0.28) {
          dome(R.st, R.P(ra0 + 0.2, b, y), 0.12, 0.07, 0.12, [0.52, 0.32, 0.16], s, Surf.Hide, 0, Math.PI / 2, 8, 2);
        }
      }
      for (const b of [rb0, rb1 - 0.04]) R.box(ra0, ra1, b, b + 0.04, 0, 1.9, WOOD, s, Surf.Wood, { skip: 4 });
    }
    // The kneading table at the front right, under the window.
    if (d > 3.6) {
      const ta0 = hw - 1.7, ta1 = hw - 0.35, tb0 = 0.55, tb1 = 1.3;
      R.box(ta0, ta1, tb0, tb1, 0.82, 0.9, [0.48, 0.36, 0.24], s, Surf.Wood, { bottom: true });
      for (const [a, b] of [[ta0 + 0.05, tb0 + 0.05], [ta1 - 0.11, tb0 + 0.05], [ta0 + 0.05, tb1 - 0.11], [ta1 - 0.11, tb1 - 0.11]]) R.box(a, a + 0.06, b, b + 0.06, 0, 0.82, BEAM, s, Surf.Wood, { skip: 16 });
      // Dough on it, and a flour-dusted board.
      dome(R.st, R.P(ta0 + 0.45, 0.92, 0.9), 0.2, 0.08, 0.16, [0.86, 0.8, 0.66], s, Surf.Stucco, 0, Math.PI / 2, 8, 2);
      R.flat(ta0 + 0.8, ta1 - 0.1, tb0 + 0.15, tb1 - 0.15, 0.905, 1, [0.82, 0.76, 0.62], s, Surf.Stucco);
    }
    // Sacks of grain against the back wall between the mill and the ledge.
    const sacks = lean ? 2 : 3;
    for (let k = 0; k < sacks; k++) {
      const a = -hw + 2.1 + k * 0.5;
      if (a > lampA - 0.75) break;
      const [x, y, z] = R.P(a, d - 0.32, 0);
      lathe(R.st, x, y, z, [[0.2, 0], [0.26, 0.22], [0.22, 0.5], [0.1, 0.62], [0.06, 0.7]], 7, [0.7, 0.62, 0.46], s + k, Surf.Stucco);
    }
    // Amphorae of oil and wine leaning in the corner by the door.
    for (let k = 0; k < 3; k++) {
      const a = -DOOR_W / 2 - 0.35 - k * 0.3, b = 0.3;
      if (a < -hw + 0.6) break;
      const c = R.P(a, b, 0);
      lathe(R.leaning(c, 0, -1, 0.18), c[0], c[1], c[2], [[0.015, 0], [0.14, 0.36], [0.055, 0.74], [0.05, 0.95]], lean ? 5 : 7, CLAY, s + k, Surf.Pavement);
    }
  }

  private lupanar(R: RoomBuilder, hw: number, d: number): void {
    const s = 0.61;
    const lime: RGB = [0.9, 0.87, 0.8];
    // The masonry bed along the side wall, its pillow built up at the head,
    // a blanket thrown over it.
    const ba0 = -hw, ba1 = -hw + 0.95, bb0 = Math.max(0.6, d - 2.1), bb1 = d;
    R.box(ba0, ba1, bb0, bb1, 0, 0.7, lime, s, Surf.Plaster, { skip: 2 | 4, p1: 20, p2: 255, top: Surf.Kerb, topC: [0.7, 0.66, 0.58] });
    R.box(ba0, ba1, bb1 - 0.5, bb1, 0.7, 0.86, lime, s, Surf.Stucco, { skip: 2 | 4 });
    const cloth: RGB = [0.56, 0.24, 0.16];
    R.poly([R.P(ba0, bb0 + 0.25, 0.72), R.P(ba1 + 0.04, bb0 + 0.25, 0.72), R.P(ba1 + 0.04, bb1 - 0.55, 0.72), R.P(ba0, bb1 - 0.55, 0.72)], [0, 1, 0], cloth, s, Surf.Stucco, 0, 0, [NO, NO, NO, NO]);
    R.poly([R.P(ba1 + 0.04, bb0 + 0.25, 0.72), R.P(ba1 + 0.04, bb1 - 0.55, 0.72), R.P(ba1 + 0.04, bb1 - 0.55, 0.35), R.P(ba1 + 0.04, bb0 + 0.25, 0.35)], R.D(1, 0, 0), cloth, s, Surf.Stucco, 0, 0, [NO, NO, NO, NO]);
    // The partition to the next cell, plastered both sides, with its doorway.
    const pa0 = 0.4, pa1 = 0.55, pb0 = d * 0.45;
    R.box(pa0, pa1, pb0, d, 0, WALL_H, lime, s, Surf.Plaster, { skip: 2 | 16, p1: 20, p2: 255 });
    R.box(pa0, pa1, d * 0.2 - 0.1, pb0, 2.3, WALL_H, lime, s, Surf.Plaster, { skip: 16, p1: 20, p2: 255, bottom: true });
    // The curtain across that doorway on its rail: a cloth hung in folds.
    const rb0 = d * 0.2, rb1 = pb0;
    tube(R.st, R.P((pa0 + pa1) / 2, rb0 - 0.1, 2.22), R.P((pa0 + pa1) / 2, rb1, 2.22), 0.02, 0.02, 5, [0.28, 0.2, 0.12], s, Surf.Wood);
    const folds = 6, am = (pa0 + pa1) / 2;
    for (let k = 0; k < folds; k++) {
      const b0 = rb0 + ((rb1 - rb0) * k) / folds, b1 = rb0 + ((rb1 - rb0) * (k + 1)) / folds;
      const a0 = am + (k % 2 ? 0.06 : -0.06), a1 = am + (k % 2 ? -0.06 : 0.06);
      for (const f of [1, -1]) R.wall(a0, b0, a1, b1, 0.12, 2.2, f, 0, [0.5, 0.3, 0.2], s, Surf.Stucco);
    }
    // A painted line framing the walls at dado height, the way the cells were done in white with red bands.
    const band: RGB = [0.55, 0.12, 0.08];
    R.wall(hw, d - 0.01, -hw, d - 0.01, 1.05, 1.11, 0, -1, band, s, Surf.Stucco);
    R.wall(hw - 0.01, 0, hw - 0.01, d, 1.05, 1.11, -1, 0, band, s, Surf.Stucco);
  }
}
