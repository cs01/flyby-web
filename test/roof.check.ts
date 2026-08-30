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
import { addBuilding, emptyScratch, type RoofExtras } from "../src/render/buildings";

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
  const extras: RoofExtras = { parapet: true, boxes: 3, overrun: true };
  for (const [i, b] of pack.buildings.slice(0, 3000).entries()) {
    addBuilding(s, b, 0, i, extras, facadeFor(b.kind, b.topM - b.baseM, i));
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
}

console.log(failures === 0 ? "\nall façade windings ok" : `\n${failures} winding check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
