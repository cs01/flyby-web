// Alcatraz's trees, by hand. The generic canopy reads the 10 m landcover,
// which calls most of the island "tree" and plants the city's mix of conifer
// spires and street trees on it, including inside the recreation yard. The
// real island has a handful of dark groves (blue gum eucalyptus and Monterey
// cypress, planted by the army) and otherwise low scrub, ice plant and
// gardens, which the drape and the shrub field already carry. So inside the
// island's box the generic trees are dropped and these groves stand in.
//
// The groves are read off the reference photographs (ferry approach, the
// dock, the 2020 drone view and a helicopter view), not surveyed: centre,
// spread and count per grove.

import type { FoliageSource } from "../render/trees";
import type { TreeInstance } from "./trees";

export interface IslandBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface Grove {
  what: string;
  lat: number;
  lon: number;
  /** Spread, metres. */
  r: number;
  n: number;
  /** Tree height range, metres. Blue gums here run to 25 m. */
  h0: number;
  h1: number;
}

export const ALCATRAZ_GROVES: readonly Grove[] = [
  { what: "blue gums on the south-east shore, beside the dock", lat: 37.82620, lon: -122.42085, r: 30, n: 16, h0: 14, h1: 24 },
  { what: "cypress and gums below the Warden's House", lat: 37.82598, lon: -122.42160, r: 22, n: 7, h0: 9, h1: 16 },
  { what: "cypress on the south slope under the cellhouse", lat: 37.82590, lon: -122.42300, r: 28, n: 6, h0: 7, h1: 13 },
  { what: "the grove on the road up from the dock", lat: 37.82735, lon: -122.42215, r: 22, n: 8, h0: 9, h1: 17 },
  { what: "trees round the Officers' Club ruin", lat: 37.82775, lon: -122.42330, r: 18, n: 5, h0: 8, h1: 14 },
];

function hash(i: number, salt: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * The groves as tree instances. A candidate on water (ground under 2 m) or on
 * a building (`blocked`) is dropped rather than moved, so a grove that runs to
 * the shore simply thins there.
 */
export function alcatrazTrees(
  toWorld: (lat: number, lon: number) => { x: number; z: number },
  groundAt: (x: number, z: number) => number,
  blocked: (x: number, z: number) => boolean,
): TreeInstance[] {
  const out: TreeInstance[] = [];
  let id = 0;
  for (const g of ALCATRAZ_GROVES) {
    const c = toWorld(g.lat, g.lon);
    let placed = 0;
    // Up to two candidates per tree, so a grove cut by the shore or a roof
    // still gets most of its count.
    for (let k = 0; k < g.n * 2 && placed < g.n; k++, id++) {
      // sqrt for an even spread over the disc, not a pile at its centre.
      const a = hash(id, 1) * Math.PI * 2;
      const d = Math.sqrt(hash(id, 2)) * g.r;
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      const y = groundAt(x, z);
      if (y < 2 || blocked(x, z)) continue;
      const heightM = g.h0 + (g.h1 - g.h0) * hash(id, 3);
      out.push({
        x, y, z, heightM,
        // Broad, heavy crowns: a wind-pruned cypress is wider than a street tree.
        radiusM: heightM * (0.36 + 0.12 * hash(id, 4)),
        yaw: hash(id, 5) * Math.PI * 2,
        species: 0,
        // The dark end of the green ramp: these groves are near black-green in
        // every photograph against the pale buildings.
        tint: 0.05 + 0.2 * hash(id, 6),
      });
      placed++;
    }
  }
  return out;
}

export function inIslandBox(b: IslandBox, x: number, z: number): boolean {
  return x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
}

/**
 * A tree source with the island's generic trees swapped for its groves.
 * Half-open tile bounds, like placeTrees, so every grove tree lands in
 * exactly one tile.
 */
export function withIslandTrees(base: FoliageSource, box: IslandBox, island: readonly TreeInstance[]): FoliageSource {
  return {
    extentM: base.extentM,
    place(x0, z0, x1, z1) {
      const out = base.place(x0, z0, x1, z1).filter((t) => !inIslandBox(box, t.x, t.z));
      for (const t of island) if (t.x >= x0 && t.x < x1 && t.z >= z0 && t.z < z1) out.push(t);
      return out;
    },
  };
}
