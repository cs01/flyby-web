// Pompeii's streets as a RoadPack, for the car sim's graph (the cart drives
// it), the street sign and the minimap; and the ground height the walker
// stands on, pavements included. Pure: the gate builds both under Bun.
//
// Every street is one narrow lane. The Romans drove on the left or right as
// the street's ruts show (one-way systems and blocked streets are attested
// for parts of the town) and none of that is modelled.

import { RoadClass, SurfaceKind, type Road, type RoadPack } from "./roadpack";
import { KERB_M, type PompeiiData } from "./pompeii";

export function pompeiiRoadPack(data: PompeiiData): RoadPack {
  const roads: Road[] = [];
  for (const s of data.streets) {
    if (s.pts.length < 4) continue;
    let cx = 0, cz = 0;
    const n = s.pts.length / 2;
    for (let i = 0; i < n; i++) { cx += s.pts[i * 2]; cz += s.pts[i * 2 + 1]; }
    roads.push({
      // Residential: driveable, and drawn by nothing (the town draws its own).
      cls: RoadClass.Residential,
      name: s.name,
      lanes: 1,
      flags: 0,
      layer: 0,
      surface: SurfaceKind.Cobblestone,
      cx: cx / n,
      cz: cz / n,
      pts: new Float32Array(s.pts),
    });
  }
  return { lat0: data.lat0, lon0: data.lon0, radiusM: 1500, roads };
}

/**
 * Wrap the terrain's height so the pavements and the insula blocks stand
 * KERB_M above the carriageway, as the town's mesh draws them. A 1 m raster
 * of the kerb outlines, filled once.
 */
export function pompeiiHeightAt(data: PompeiiData, base: (x: number, z: number) => number, offX = 0, offZ = 0): (x: number, z: number) => number {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < data.wall.length; i += 2) {
    x0 = Math.min(x0, data.wall[i]); x1 = Math.max(x1, data.wall[i]);
    z0 = Math.min(z0, data.wall[i + 1]); z1 = Math.max(z1, data.wall[i + 1]);
  }
  const W = Math.ceil(x1 - x0) + 1, H = Math.ceil(z1 - z0) + 1;
  const raised = new Uint8Array(W * H);
  const xs: number[] = [];
  for (const ins of data.insulae) {
    const r = ins.kerb, n = r.length / 2;
    for (let j = 0; j < H; j++) {
      const z = z0 + j + 0.5;
      xs.length = 0;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const za = r[a * 2 + 1], zb = r[b * 2 + 1];
        if (za > z !== zb > z) xs.push(r[a * 2] + ((z - za) / (zb - za)) * (r[b * 2] - r[a * 2]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - x0 - 0.5)), i1 = Math.min(W - 1, Math.floor(xs[k + 1] - x0 - 0.5));
        for (let i = i0; i <= i1; i++) raised[j * W + i] = 1;
      }
    }
  }
  return (x: number, z: number): number => {
    const g = base(x, z);
    const i = Math.floor(x - offX - x0), j = Math.floor(z - offZ - z0);
    if (i < 0 || j < 0 || i >= W || j >= H || !raised[j * W + i]) return g;
    return g + KERB_M;
  };
}
