// Shared by test/pompeii.check.ts and test/herculaneum.check.ts: which columns
// carry nothing and which stand on nothing, read off the built mesh.
//
// Straight up from a capital the mesh must be within 5 cm (an architrave, a
// beam, a roof's underside), and down from the base there must be a floor
// within 5 cm under it or one it is set into.

import type { PompeiiModel } from "../src/render/pompeiimesh";

export interface Unsupported { top: number; base: number; at: { x: number; z: number; why: "top" | "base" }[] }

/**
 * `ground` is the terrain the town stands on: outside the walls a tomb's or a
 * villa's columns may stand on the bare hillside, which is not in the town mesh.
 */
export function unsupportedColumns(m: PompeiiModel, ground: (x: number, z: number) => number, keep: (x: number, z: number) => boolean = () => true): Unsupported & { n: number } {
  const meshes = [m.mesh, m.floor, m.streets];
  const grid = new Map<number, [number, number][]>();
  const key = (i: number, j: number): number => i * 100003 + j;
  meshes.forEach((st, mi) => {
    const P = st.position, I = st.index;
    for (let t = 0; t < I.length; t += 3) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let j = 0; j < 3; j++) { const v = I[t + j]; x0 = Math.min(x0, P[v * 3]); x1 = Math.max(x1, P[v * 3]); z0 = Math.min(z0, P[v * 3 + 2]); z1 = Math.max(z1, P[v * 3 + 2]); }
      if (x1 - x0 > 300 || z1 - z0 > 300) continue;
      for (let i = Math.floor(x0 / 2); i <= Math.floor(x1 / 2); i++) for (let j = Math.floor(z0 / 2); j <= Math.floor(z1 / 2); j++) (grid.get(key(i, j)) ?? grid.set(key(i, j), []).get(key(i, j))!).push([mi, t]);
    }
  });
  const heights = (x: number, z: number): number[] => {
    const out: number[] = [];
    for (const [mi, t] of grid.get(key(Math.floor(x / 2), Math.floor(z / 2))) ?? []) {
      const P = meshes[mi].position, I = meshes[mi].index;
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const d = (P[b + 2] - P[c + 2]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 2] - P[c + 2]);
      if (Math.abs(d) < 1e-9) continue;
      const wa = ((P[b + 2] - P[c + 2]) * (x - P[c]) + (P[c] - P[b]) * (z - P[c + 2])) / d;
      const wb = ((P[c + 2] - P[a + 2]) * (x - P[c]) + (P[a] - P[c]) * (z - P[c + 2])) / d;
      if (wa < -1e-6 || wb < -1e-6 || wa + wb > 1 + 1e-6) continue;
      out.push(wa * P[a + 1] + wb * P[b + 1] + (1 - wa - wb) * P[c + 1]);
    }
    return out;
  };
  let top = 0, base = 0, n = 0;
  const at: Unsupported["at"] = [];
  for (const c of m.posts) {
    if (!keep(c.x, c.z)) continue;
    n++;
    const t = c.y0 + c.h, hs = [...heights(c.x, c.z), ground(c.x, c.z)];
    if (!hs.some((y) => y >= t - 0.1 && y <= t + 0.05)) { top++; at.push({ x: c.x, z: c.z, why: "top" }); }
    if (!hs.some((y) => y >= c.y0 - 0.05 && y < t - 0.5)) { base++; at.push({ x: c.x, z: c.z, why: "base" }); }
  }
  return { top, base, at, n };
}
