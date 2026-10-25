// The strip between the two halves of a divided road.
//
// WHY. OSM draws a divided avenue as two one-way ways, each with its own
// width, and the ribbons cover exactly those widths. Whatever is between them
// (a planted median, a kerbed island, Van Ness Avenue's centre-running bus
// lanes) is in no pack, so the terrain drape shows through: in the owner's
// sf-street report, a green, glossy band of photographed tree crowns lying on
// the road beside the kerb. A median strip fills that gap with paving at road
// level, drawn under the ribbons.
//
// Pure: test/junction.check.ts measures coverage of the gaps.

import { roadWidthM, ROAD_BRIDGE, ROAD_ONEWAY, ROAD_TUNNEL, RoadClass, type Road } from "./roadpack";

/** Widest gap between two carriageways still called a median, metres. Van
 *  Ness's centre is about 9 m; past ~12 m it is a park or a block. */
export const MAX_MEDIAN_M = 12;
/** Spacing the halves are sampled at, metres. */
const SAMPLE_M = 6;

export interface MedianPiece {
  /** Two centre points, x, z, x, z. */
  pts: Float32Array;
  widthM: number;
  /** The way it runs beside, for the material. */
  road: number;
}

function divided(r: Road): boolean {
  return (r.flags & ROAD_ONEWAY) !== 0 && (r.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) === 0 &&
    r.cls <= RoadClass.Secondary;
}

/** Median pieces along every one-way that has an opposing one-way within
 *  MAX_MEDIAN_M of its LEFT kerb (right-hand traffic: the other half of a
 *  divided road is on the driver's left). */
export function medianPieces(roads: readonly Road[]): MedianPiece[] {
  const cell = 32;
  const grid = new Map<number, number[]>();
  const key = (x: number, z: number): number => Math.floor(x / cell) * 100003 + Math.floor(z / cell);
  const ids: number[] = [];
  for (let i = 0; i < roads.length; i++) {
    if (!divided(roads[i])) continue;
    ids.push(i);
    const p = roads[i].pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]) / cell));
      for (let q = 0; q <= n; q++) {
        const kk = key(p[k] + (p[k + 2] - p[k]) * (q / n), p[k + 1] + (p[k + 3] - p[k + 1]) * (q / n));
        const b = grid.get(kk);
        if (!b) grid.set(kk, [i]); else if (b[b.length - 1] !== i) b.push(i);
      }
    }
  }

  const out: MedianPiece[] = [];
  for (const i of ids) {
    const r = roads[i];
    const hwA = roadWidthM(r.cls, r.lanes, r.flags) / 2;
    const p = r.pts;
    let prev: { x: number; z: number; w: number } | null = null;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const dx = p[k + 2] - p[k], dz = p[k + 3] - p[k + 1];
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;
      const tx = dx / L, tz = dz / L;
      const lx = tz, lz = -tx; // left of travel
      const n = Math.max(1, Math.ceil(L / SAMPLE_M));
      for (let q = (k === 0 ? 0 : 1); q <= n; q++) {
        const sx = p[k] + dx * (q / n), sz = p[k + 1] + dz * (q / n);
        // Nearest opposing one-way to the left.
        let best = Infinity, bestHw = 0, bestJ = -1;
        const cells = new Set<number>();
        for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) cells.add(key(sx + gx * cell, sz + gz * cell));
        for (const c of cells) {
          for (const j of grid.get(c) ?? []) {
            if (j === i) continue;
            const o = roads[j];
            const po = o.pts;
            for (let m = 0; m + 3 < po.length; m += 2) {
              const ex = po[m + 2] - po[m], ez = po[m + 3] - po[m + 1];
              const l2 = ex * ex + ez * ez;
              if (l2 <= 0) continue;
              const el = Math.sqrt(l2);
              if ((ex * tx + ez * tz) / el > -0.9) continue; // anti-parallel only
              const t = Math.max(0, Math.min(1, ((sx - po[m]) * ex + (sz - po[m + 1]) * ez) / l2));
              const cx = po[m] + ex * t - sx, cz = po[m + 1] + ez * t - sz;
              const side = cx * lx + cz * lz;
              const along = Math.abs(cx * tx + cz * tz);
              if (side <= 0 || along > 2) continue;
              if (side < best) { best = side; bestHw = roadWidthM(o.cls, o.lanes, o.flags) / 2; bestJ = j; }
            }
          }
        }
        const gap = best - hwA - bestHw;
        // Each median is seen from both halves; the lower-numbered way draws it.
        if (gap > 0.2 && gap <= MAX_MEDIAN_M && i < bestJ) {
          // Centred in the gap, and a little wider than it so it tucks under
          // both ribbons rather than leaving a hairline at either kerb.
          const here = { x: sx + lx * (hwA + gap / 2), z: sz + lz * (hwA + gap / 2), w: gap + 0.6 };
          if (prev && Math.hypot(here.x - prev.x, here.z - prev.z) < SAMPLE_M * 2) {
            out.push({ pts: new Float32Array([prev.x, prev.z, here.x, here.z]), widthM: (prev.w + here.w) / 2, road: i });
          }
          prev = here;
        } else {
          prev = null;
        }
      }
    }
  }
  return out;
}
