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
import { buildAlcatrazModel, pointInRing, DECAL_TEXT } from "../src/render/alcatrazmesh";
import { ALCATRAZ_STRUCTURE_TRIS, ALCATRAZ_STRUCTURE_VERTS, DECAL_ATLAS_ROWS } from "../src/render/budget";
import { alcatrazTrees, inIslandBox, withIslandTrees } from "../src/data/alcatrazveg";
import type { TreeInstance } from "../src/data/trees";

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

  // Building 64 against the dock photographs: eaves ~24 m over the water,
  // so from the dock to the roof it must stand well over 18 m.
  const b64 = find("Building 64");
  check("Building 64 rises 18+ m from the dock", !!b64 && b64.topY - b64.groundY > 18 && b64.groundY < 6, b64 ? `${b64.groundY.toFixed(1)} -> ${b64.topY.toFixed(1)} m` : "missing");
  const gt = find("Guard Tower");
  check("dock guard tower 13-18 m", !!gt && gt.topY - gt.groundY > 13 && gt.topY - gt.groundY < 18, gt ? `${(gt.topY - gt.groundY).toFixed(1)} m` : "missing");

  // The budget's literal structure counts must cover the real model, or the
  // phone tier's memory line under-counts it.
  const verts = model.mesh.position.length / 3;
  check("structure mesh within the budget's literals", verts <= ALCATRAZ_STRUCTURE_VERTS && model.mesh.triangles <= ALCATRAZ_STRUCTURE_TRIS,
    `${verts}/${ALCATRAZ_STRUCTURE_VERTS} verts, ${model.mesh.triangles}/${ALCATRAZ_STRUCTURE_TRIS} tris`);

  // --- 5. the painted lettering ---------------------------------------------
  check("every atlas row is placed once", model.decals.length === DECAL_TEXT.length && DECAL_TEXT.length === DECAL_ATLAS_ROWS
    && new Set(model.decals.map((d) => d.row)).size === DECAL_TEXT.length, `${model.decals.length} placed, ${DECAL_TEXT.length} rows`);
  // Each rect must land on vertices of its own group, inside their u/v span:
  // a rect off its surface paints nothing and fails nowhere else.
  const inSpan = (d: (typeof model.decals)[number], mesh: typeof model.mesh): boolean => {
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < mesh.decal.length; i++) {
      if (mesh.decal[i] !== d.group) continue;
      u0 = Math.min(u0, mesh.wall[i * 4]); u1 = Math.max(u1, mesh.wall[i * 4]);
      v0 = Math.min(v0, mesh.wall[i * 4 + 1]); v1 = Math.max(v1, mesh.wall[i * 4 + 1]);
    }
    const [u, v, w, h] = d.rect;
    return u - Math.abs(w) / 2 >= u0 && u + Math.abs(w) / 2 <= u1 && v - h / 2 >= v0 && v + h / 2 <= v1;
  };
  const off = model.decals.filter((d) => !inSpan(d, model.mesh));
  check("every lettering rect lies on its painted surface", off.length === 0, off.map((d) => DECAL_TEXT[d.row].text).join(", "));
  const shifted = { ...model.decals[0], rect: [model.decals[0].rect[0] + 200, ...model.decals[0].rect.slice(1)] as [number, number, number, number] };
  check("probe: a rect moved 200 m along its facade is caught", !inSpan(shifted, model.mesh), "");

  // --- 6. the island's trees --------------------------------------------------
  const blocked = (x: number, z: number): boolean =>
    (model.yard !== null && pointInRing(x, z, model.yard)) || model.footprints.some((r) => pointInRing(x, z, r));
  const groves = alcatrazTrees(toWorld, groundAt, blocked);
  const wet = groves.filter((t) => t.y < 2).length;
  const roofed = groves.filter((t) => blocked(t.x, t.z)).length;
  check("groves planted: 30+ trees, none in the sea, on a roof or in the yard", groves.length >= 30 && wet === 0 && roofed === 0,
    `${groves.length} trees, ${wet} wet, ${roofed} roofed`);
  check("probe: with everywhere blocked no grove tree stands", alcatrazTrees(toWorld, groundAt, () => true).length === 0, "");

  // The island's box in this test's frame, from the lidar's dry cells.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let j = 0; j < meta.h; j += 4) for (let i = 0; i < meta.w; i += 4) {
    if (heights[j * meta.w + i] <= 0.3) continue;
    const p = toWorld(meta.bbox.north - ((j + 0.5) / meta.h) * (meta.bbox.north - meta.bbox.south), meta.bbox.west + ((i + 0.5) / meta.w) * (meta.bbox.east - meta.bbox.west));
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const box = { minX, maxX, minZ, maxZ };
  // A stand-in for the generic canopy: a conifer every 8 m, everywhere.
  const blanket = {
    extentM: 1e6,
    place(x0: number, z0: number, x1: number, z1: number) {
      const out: TreeInstance[] = [];
      for (let z = Math.ceil(z0 / 8) * 8; z < z1; z += 8) for (let x = Math.ceil(x0 / 8) * 8; x < x1; x += 8) {
        out.push({ x, y: 0, z, heightM: 20, radiusM: 4, yaw: 0, species: 2, tint: 0.5 });
      }
      return out;
    },
  };
  const wrapped = withIslandTrees(blanket, box, groves);
  // Tiles of 256 m over the box and a margin, the way the renderer asks.
  const tiles = (src: typeof blanket): TreeInstance[] => {
    const all: TreeInstance[] = [];
    for (let z = Math.floor((minZ - 300) / 256) * 256; z < maxZ + 300; z += 256) {
      for (let x = Math.floor((minX - 300) / 256) * 256; x < maxX + 300; x += 256) all.push(...src.place(x, z, x + 256, z + 256));
    }
    return all;
  };
  const got = tiles(wrapped);
  const genericInBox = got.filter((t) => t.species === 2 && inIslandBox(box, t.x, t.z)).length;
  const groveSeen = got.filter((t) => groves.includes(t)).length;
  const outside = got.filter((t) => !inIslandBox(box, t.x, t.z)).length;
  check("no generic trees inside the island box", genericInBox === 0, `${genericInBox} inside`);
  check("each grove tree lands in exactly one tile", groveSeen === groves.length, `${groveSeen}/${groves.length}`);
  check("generic trees outside the box are kept", outside > 1000, `${outside} kept`);
  const raw = tiles(blanket).filter((t) => inIslandBox(box, t.x, t.z)).length;
  check("probe: unwrapped, the generic canopy does cover the island", raw > 500, `${raw} inside`);
}

console.log(failures ? `alcatraz: ${failures} FAILED` : "alcatraz: all checks pass");
if (failures) process.exit(1);
