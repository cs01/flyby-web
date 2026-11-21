// The gate on Alcatraz's baked asset and the pure halves of its renderer
// (src/data/alcatraz.ts, src/render/alcatrazmesh.ts).
//
// Bounds are LITERALS from outside the code under test: the island's survey
// high point is 41 m (NPS), the lighthouse is 26 m (OSM height, NPS), the
// cellhouse footprint is about 80 x 30 m. Each block carries a vacuity probe:
// the same predicate on an input it could not pass, asserted to fail.

import { readFileSync } from "node:fs";
import {
  AlcatrazPatch,
  decodeHeights,
  encodeHeights,
  minFilter,
  patchedHeight,
  ringHeight,
  ringAreaM2,
  type AlcatrazMeta,
} from "../src/data/alcatraz";
import { buildAlcatrazModel } from "../src/render/alcatrazmesh";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(60)} ${detail}`);
  if (!ok) failures++;
}

const dir = new URL("../public/landmarks/", import.meta.url).pathname;
const meta = JSON.parse(readFileSync(`${dir}alcatraz.json`, "utf8")) as AlcatrazMeta;
const heights = decodeHeights(new Uint8Array(readFileSync(`${dir}alcatraz.height`)), meta.w * meta.h);
const patch = new AlcatrazPatch(meta, heights);

// --- 1. the heights are the island's ------------------------------------------

/** Range, land fraction and the spread of land heights: what a flat or empty patch cannot fake. */
function shape(h: Float32Array): { max: number; min: number; land: number; sd: number } {
  let max = -Infinity, min = Infinity, land = 0, s = 0, s2 = 0;
  for (const v of h) {
    max = Math.max(max, v);
    min = Math.min(min, v);
    if (v > 0.5) { land++; s += v; s2 += v * v; }
  }
  const mean = s / Math.max(1, land);
  return { max, min, land: land / h.length, sd: Math.sqrt(Math.max(0, s2 / Math.max(1, land) - mean * mean)) };
}
const isIsland = (s: ReturnType<typeof shape>): boolean =>
  s.min >= 0 && s.max > 36 && s.max < 46 && s.land > 0.1 && s.land < 0.45 && s.sd > 6;

{
  const s = shape(heights);
  check("heights within 0..46 m, top near the 41 m survey point", s.min >= 0 && s.max > 36 && s.max < 46, `min ${s.min.toFixed(2)} max ${s.max.toFixed(1)}`);
  check("land is 10-45% of the box (island in open water)", s.land > 0.1 && s.land < 0.45, `${(s.land * 100).toFixed(1)}%`);
  check("land heights spread (cliffs, a hill, not a slab)", s.sd > 6, `sd ${s.sd.toFixed(1)} m`);
  check("heights pass the island test", isIsland(s), "");
  // Vacuity: the same test must reject a flat patch, and a flat 20 m plateau.
  const flat = new Float32Array(heights.length);
  check("probe: a flat sea-level patch fails the island test", !isIsland(shape(flat)), "");
  const slab = heights.map((v) => (v > 0.5 ? 20 : 0));
  check("probe: a flat-topped slab of the same outline fails it", !isIsland(shape(slab)), `sd ${shape(slab).sd.toFixed(2)}`);

  // Cliffs: the steepest lidar step between neighbouring cells.
  let steep = 0;
  for (let y = 0; y < meta.h; y++) for (let x = 1; x < meta.w; x++) steep = Math.max(steep, Math.abs(heights[y * meta.w + x] - heights[y * meta.w + x - 1]) / patch.cellX);
  check("has cliffs: some cell-to-cell slope steeper than 2:1", steep > 2, `max slope ${steep.toFixed(1)}`);
}

// --- 2. the encoding round-trips ----------------------------------------------
{
  const back = decodeHeights(encodeHeights(heights), heights.length);
  let err = 0;
  for (let i = 0; i < heights.length; i++) err = Math.max(err, Math.abs(back[i] - heights[i]));
  check("height encoding round-trips to the centimetre", err <= 0.005 + 1e-6, `max err ${err.toFixed(4)} m`);
  let threw = false;
  try { decodeHeights(encodeHeights(heights), heights.length + 1); } catch { threw = true; }
  check("probe: a wrong cell count is refused, not padded", threw, "");
}

// --- 3. the ring field never rises above the lidar ---------------------------
{
  patch.erode(40);
  const ring = ringHeight(patch, () => 25);
  const truth = patchedHeight(patch, () => 25);
  let worst = -Infinity;
  const b = meta.bbox;
  for (let j = 0; j <= 200; j++) {
    for (let i = 0; i <= 200; i++) {
      const lat = b.south + ((b.north - b.south) * j) / 200;
      const lon = b.west + ((b.east - b.west) * i) / 200;
      worst = Math.max(worst, ring(lat, lon) - truth(lat, lon));
    }
  }
  check("eroded ring field is at or below the true ground", worst <= 1e-3, `worst ${worst.toFixed(3)} m above`);
  // Vacuity: plain (un-eroded) bilinear sampling on a COARSE grid does poke
  // above the truth somewhere, which is the failure the erosion exists for.
  let poke = 0;
  const step = 40 / 111_132;
  for (let lat = b.south; lat < b.north - step; lat += step) {
    for (let lon = b.west; lon < b.east - step * 1.27; lon += step * 1.27) {
      const a = patch.sample(lat, lon), c = patch.sample(lat, lon + step * 1.27);
      const mid = patch.sample(lat, lon + step * 0.635);
      poke = Math.max(poke, (a + c) / 2 - mid);
    }
  }
  check("probe: un-eroded 40 m cells would cut through the cliffs", poke > 3, `${poke.toFixed(1)} m above`);
  const m = minFilter(new Float32Array([5, 1, 7, 9, 3, 8]), 6, 1, 1, 0);
  check("min filter is a true running minimum", m.join(",") === "1,1,1,3,3,3", m.join(","));
}

// --- 4. the structures --------------------------------------------------------
{
  const lat0 = 37.8085, lon0 = -122.4098;
  const toWorld = (lat: number, lon: number) => ({ x: (lon - lon0) * 87_960, z: -(lat - lat0) * 111_132 });
  const groundAt = (x: number, z: number): number => patch.sample(lat0 - z / 111_132, lon0 + x / 87_960);
  const model = buildAlcatrazModel({ features: meta.features, toWorld, groundAt });
  const find = (name: string) => model.modelled.find((m) => m.name === name);

  const lh = model.modelled.find((m) => m.kind === "lighthouse");
  check("lighthouse modelled", !!lh, lh ? lh.name : "missing");
  if (lh) check("lighthouse is 26 m tall", Math.abs(lh.topY - lh.groundY - 26) < 1, `${(lh.topY - lh.groundY).toFixed(1)} m`);
  check("lighthouse has a lantern", !!model.lantern, "");
  const cell = find("Main Prison");
  check("cellhouse modelled", !!cell, cell ? `top ${cell.topY.toFixed(1)} m` : "missing");
  const cf = meta.features.find((f) => f.tags["name"] === "Main Prison");
  const area = cf ? ringAreaM2(cf.ll) : 0;
  check("cellhouse footprint 1500-4500 m^2", area > 1500 && area < 4500, `${area.toFixed(0)} m^2`);
  if (cell) check("cellhouse stands on the hilltop (ground 30-43 m)", cell.groundY > 30 && cell.groundY < 43, `${cell.groundY.toFixed(1)} m`);
  for (const k of ["water_tower", "chimney", "ruin", "guard_tower"] as const) {
    check(`${k} modelled`, model.modelled.some((m) => m.kind === k), "");
  }
  check("recreation yard walls are the tall ones", model.modelled.some((m) => m.kind === "wall" && m.topY - m.groundY > 6), "");
  check("structures are real geometry", model.mesh.triangles > 2000, `${model.mesh.triangles} tris`);
  // Vacuity: with the outlines taken away the same checks come back empty.
  const none = buildAlcatrazModel({ features: [], toWorld, groundAt });
  check("probe: no outlines, no lighthouse and no cellhouse", !none.lantern && none.modelled.length === 0, "");
}

console.log(failures ? `alcatraz: ${failures} FAILED` : "alcatraz: all checks pass");
if (failures) process.exit(1);
