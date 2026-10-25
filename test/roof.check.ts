// The gate on which way building faces point.
//
// This exists because the city shipped as open-topped boxes and nobody caught
// it from the ground. Backface culling makes a winding error INVISIBLE from
// most angles: a roof wound the wrong way looks perfect until you fly over it
// and see straight down into the shaft, and a wall wound the wrong way shows
// you the inside of the far wall lit by a normal pointing away from you.
//
// Both have actually happened here. The walls were fixed once (see the note in
// buildings.ts) and the roofs stayed broken: measured at 99.8% of roof
// triangles facing DOWN on the Manhattan pack.
//
// So this asserts the thing culling depends on, which is not the shading
// normal but the GEOMETRIC winding, and it asserts it against the real
// addBuilding rather than a reimplementation of it -- a second copy of the
// winding logic would just agree with itself.
//
// Watched to fail: reversing either winding in buildings.ts takes the matching
// percentage to ~0 and this exits 1.

import { readdirSync } from "node:fs";
import { parseCityPack } from "../src/data/citypack";
import { facadeFor } from "../src/render/facade";
import { ARCHETYPES } from "../src/render/archetype";
import {
  PART_CLUTTER,
  PART_PARAPET,
  PART_SHINGLE,
  addBuilding,
  addDetail,
  emptyScratch,
  insideRing,
  pitchFor,
  type RoofExtras,
} from "../src/render/buildings";

const DIR = "public/cities";
let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${detail}`);
  if (!ok) failures++;
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".city")).sort()) {
  const pack = parseCityPack(await Bun.file(`${DIR}/${file}`).arrayBuffer());
  const s = emptyScratch();
  // A slice, not the whole pack: 3000 footprints is tens of thousands of
  // triangles, which is plenty to catch a systematic winding flip, and the
  // whole suite has to stay fast enough that people run it.
  // WITH the roof extras on, always. The parapet's inner face and the five
  // faces of every plant box are new windings, they are exactly the kind of
  // thing that comes out inside-out, and backface culling would hide it from
  // anyone not standing in precisely the wrong place.
  // Street and relief on too, and every other building drawn as a Victorian
  // or a walk-up, so the awnings, cornices and bay windows (all built at
  // arbitrary angles off the ring) are in the count.
  const extras: RoofExtras = { parapet: true, boxes: 3, overrun: true, tank: true };
  const relief = ["sf-victorian", "nyc-walkup"].map((id) => ARCHETYPES.findIndex((a) => a.id === id));
  for (const [i, b] of pack.buildings.slice(0, 3000).entries()) {
    const choice = i % 2 ? { archetype: relief[(i >> 1) % 2], district: 0, cluster: i } : null;
    const fp = facadeFor(b.kind, b.topM - b.baseM, i, choice);
    addBuilding(s, b, 0, i, extras, fp);
    addDetail(s, b, 0, i, fp, true, true, true, () => false, true);
  }

  let roofUp = 0, roofDown = 0, wallOut = 0, wallIn = 0, degenerate = 0;

  for (let t = 0; t + 2 < s.idx.length; t += 3) {
    const [ia, ib, ic] = [s.idx[t], s.idx[t + 1], s.idx[t + 2]];
    const v = (i: number) => [s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]] as const;
    const [ax, ay, az] = v(ia), [bx, by, bz] = v(ib), [cx, cy, cz] = v(ic);
    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    // Geometric normal: the one the GPU uses to decide facing.
    const gx = e1[1] * e2[2] - e1[2] * e2[1];
    const gy = e1[2] * e2[0] - e1[0] * e2[2];
    const gz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(gx, gy, gz);
    if (len < 1e-9) { degenerate++; continue; }

    // info.z is 1 on roof vertices and 0 on walls.
    const isRoof = s.info[ia * 4 + 2] > 0.5;
    if (isRoof) {
      gy > 0 ? roofUp++ : roofDown++;
    } else {
      // A wall must FACE THE WAY IT IS SHADED. The shading normal is stored per
      // vertex; if the winding disagrees with it the visible side is the one
      // lit by the normal of the side you cannot see.
      const dot = gx * s.nrm[ia * 3] + gy * s.nrm[ia * 3 + 1] + gz * s.nrm[ia * 3 + 2];
      dot > 0 ? wallOut++ : wallIn++;
    }
  }

  const roofPct = (100 * roofUp) / Math.max(1, roofUp + roofDown);
  const wallPct = (100 * wallOut) / Math.max(1, wallOut + wallIn);
  const name = file.replace(".city", "");
  check(`${name} roofs face up`, roofPct > 99, `${roofPct.toFixed(1)}% of ${roofUp + roofDown} (want >99)`);
  check(`${name} walls face outward`, wallPct > 99, `${wallPct.toFixed(1)}% of ${wallOut + wallIn} (want >99)`);

  // --- The pitched roof -------------------------------------------------
  //
  // Which buildings took the pitch is asked of buildings.ts rather than
  // decided again here, for the reason in this file's header: a second copy of
  // the rule would only ever agree with itself. What IS checked here is the
  // geometry that came out, one building at a time so a failure names a
  // footprint instead of a pack.
  let pitched = 0;
  let withParapet = 0, withClutter = 0, ridgeMoved = 0, wallTooShort = 0, noOverhang = 0;

  for (const [i, b] of pack.buildings.slice(0, 3000).entries()) {
    const height = b.topM - b.baseM;
    const fp = facadeFor(b.kind, height, i);
    // The seed addBuilding derives for this building.
    if (!pitchFor(b, height, fp.seed * 4096)) continue;
    pitched++;

    const one = emptyScratch();
    addBuilding(one, b, 0, i, extras, fp);

    let maxY = -Infinity;
    let wallH = Infinity;
    let outside = 0;
    for (let v = 0; v * 3 < one.pos.length; v++) {
      const part = one.info[v * 4 + 3];
      if (part === PART_PARAPET) withParapet++;
      if (part === PART_CLUTTER) withClutter++;
      maxY = Math.max(maxY, one.pos[v * 3 + 1]);
      wallH = Math.min(wallH, one.info[v * 4 + 1]);
      // An eave that projects has to land outside the footprint it projects
      // over. Nothing else in the file measures the overhang at all.
      if (part === PART_SHINGLE && !insideRing(b.ring, one.pos[v * 3], one.pos[v * 3 + 2])) outside++;
    }
    // The ridge takes the flat top's place exactly: the drone collider and the
    // skyline both read topM and neither is told about the roof.
    if (Math.abs(maxY - b.topM) > 1e-3) ridgeMoved++;
    // What is left under the tent still has to be a storey.
    if (wallH < 2.4 - 1e-6) wallTooShort++;
    if (outside === 0) noOverhang++;
  }

  check(`${name} pitched roofs built`, pitched > 0, `${pitched} of 3000 sampled`);
  check(`${name} pitched: no parapet`, withParapet === 0, `${withParapet} parapet vertices (want 0)`);
  check(`${name} pitched: no plant`, withClutter === 0, `${withClutter} clutter vertices (want 0)`);
  check(`${name} pitched: ridge at top`, ridgeMoved === 0, `${ridgeMoved} of ${pitched} moved the top`);
  check(`${name} pitched: wall >= 2.4 m`, wallTooShort === 0, `${wallTooShort} of ${pitched} under 2.4 m`);
  check(`${name} pitched: eave overhangs`, noOverhang === 0, `${noOverhang} of ${pitched} inside the ring`);
}

console.log(failures === 0 ? "\nall façade windings ok" : `\n${failures} winding check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
