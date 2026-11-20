// The inside of the car or cabin being ridden: floor, walls with a window band,
// ceiling and benches, all facing in. The exterior meshes are outward-facing
// boxes drawn front-side only, so from inside they cull away entirely and the
// person would see the track, the street and the sky through the hull; this
// shell is what is seen instead, and the window band is a gap in it, so the
// city goes past through the windows. Same lighting as the exterior
// (trafficMaterial), so a car interior sits in the scene's light.

import * as THREE from "three";
import type { AircraftModel } from "./aircraftmodel";
import { Soup } from "./transit";
import type { Deck } from "../sim/ride";

const FLOOR = new THREE.Color(0x24211e);
const WALL = new THREE.Color(0xd9d6cc);
const CEIL = new THREE.Color(0xeeece6);
const SEAT = 0x5a3c2a;

/** Clear of the exterior box faces, which sit on the deck outline. */
const INSET = 0.06;

/** A quad seen from the side its normal points to; `a..d` counter-clockwise from there. */
function quad(s: Soup, a: number[], b: number[], c: number[], d: number[], n: number[], col: THREE.Color): void {
  s.quad(a, b, c, d, n, col);
}

/** A wall panel on x = const, between z0..z1 and y0..y1, facing toward `nx`. */
function wallX(s: Soup, x: number, nx: number, z0: number, z1: number, y0: number, y1: number): void {
  if (nx > 0) quad(s, [x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], [1, 0, 0], WALL);
  else quad(s, [x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], [-1, 0, 0], WALL);
}

function wallZ(s: Soup, z: number, nz: number, x0: number, x1: number, y0: number, y1: number): void {
  if (nz > 0) quad(s, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1], WALL);
  else quad(s, [x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], [0, 0, -1], WALL);
}

export function cabinGeometry(d: Deck, benches: boolean): THREE.BufferGeometry {
  const s = new Soup();
  const hx = d.hx - INSET, z0 = d.z0 + INSET, z1 = d.z1 - INSET;
  const f = d.floor + 0.02, c = d.ceil - INSET;
  // Windows from sill to head, the band the exterior glass covers.
  const sill = f + 0.85, head = Math.min(c - 0.25, f + 1.75);
  quad(s, [-hx, f, z0], [-hx, f, z1], [hx, f, z1], [hx, f, z0], [0, 1, 0], FLOOR);
  quad(s, [-hx, c, z1], [-hx, c, z0], [hx, c, z0], [hx, c, z1], [0, -1, 0], CEIL);
  for (const [y0, y1] of [[f, sill], [head, c]]) {
    wallX(s, -hx, 1, z0, z1, y0, y1);
    wallX(s, hx, -1, z0, z1, y0, y1);
    wallZ(s, z0, 1, -hx, hx, y0, y1);
    wallZ(s, z1, -1, -hx, hx, y0, y1);
  }
  // Window piers at the ends, so the end windows are the width of a door.
  const pier = Math.max(0, hx - 0.6);
  for (const [z, nz] of [[z0, 1], [z1, -1]]) {
    wallZ(s, z, nz, -hx, -hx + pier, sill, head);
    wallZ(s, z, nz, hx - pier, hx, sill, head);
  }
  if (benches) {
    // Longitudinal benches along both walls, inside the wall margin the eye is
    // kept out of, with a gap at mid-car for the doors.
    const mid = (z0 + z1) / 2;
    for (const sx of [-1, 1]) {
      const xa = sx * hx, xb = sx * (hx - 0.45);
      for (const [za, zb] of [[z0 + 0.8, mid - 0.9], [mid + 0.9, z1 - 0.8]]) {
        if (zb - za < 1) continue;
        s.box(Math.min(xa, xb), Math.max(xa, xb), f, f + 0.45, za, zb, SEAT);
      }
    }
  }
  return s.geometry();
}

/** One shell per deck shape, built on first ride and kept. */
export class CabinRender {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.InstancedMesh>();
  private shown: THREE.InstancedMesh | null = null;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(private aircraft: AircraftModel) {
    this.group.name = "cabin";
  }

  /** Shows the shell for `key` at the pose, or hides it with key null. */
  show(key: string | null, deck: Deck | null, benches: boolean, x: number, y: number, z: number, yaw: number, pitch: number): void {
    let mesh = key ? this.meshes.get(key) : undefined;
    if (key && !mesh && deck) {
      const mat = this.aircraft.trafficMaterial(null);
      mat.uniforms.uRoughness.value = 0.85;
      // The environment probe is open sky; indoors most of it is roof, and at
      // full strength the floor mirrors the sky blue at grazing angles.
      mat.uniforms.uEnvStrength.value = 0.3;
      mesh = new THREE.InstancedMesh(cabinGeometry(deck, benches), mat, 1);
      // The camera is always inside it; a bounding test against it is noise.
      mesh.frustumCulled = false;
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
    if (this.shown && this.shown !== mesh) this.shown.visible = false;
    this.shown = mesh ?? null;
    if (!mesh) return;
    mesh.visible = true;
    this.e.set(pitch, yaw, 0, "YXZ");
    this.q.setFromEuler(this.e);
    this.m.compose(this.p.set(x, y, z), this.q, this.one);
    mesh.setMatrixAt(0, this.m);
    mesh.instanceMatrix.needsUpdate = true;
  }
}
