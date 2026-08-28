import { parseCityPack } from "../src/data/citypack";
import { Origin } from "../src/geo";
import { signedArea } from "../src/render/earcut";

const buf = await Bun.file("public/cities/sf.city").arrayBuffer();
const pack = parseCityPack(buf);
const o = new Origin(pack.lat0, pack.lon0);

const heights = pack.buildings.map((b) => b.topM - b.baseM).sort((a, b) => a - b);
const q = (p: number) => +heights[Math.floor(p * (heights.length - 1))].toFixed(1);

const tallest = [...pack.buildings].sort((a, b) => (b.topM - b.baseM) - (a.topM - a.baseM)).slice(0, 6);

console.log("origin", pack.lat0, pack.lon0, "radius", pack.radiusM);
console.log("buildings", pack.buildings.length);
console.log("height p50", q(0.5), "p90", q(0.9), "p99", q(0.99), "max", q(1));
console.log("tallest:");
for (const b of tallest) {
  const ll = o.toLatLon(b.cx, b.cz);
  console.log(`  ${(b.topM - b.baseM).toFixed(0).padStart(4)} m  ${ll.lat.toFixed(4)},${ll.lon.toFixed(4)}  verts=${b.ring.length / 2}`);
}

// Landmarks must land where they really are.
function near(lat: number, lon: number, minH: number, name: string) {
  const t = o.toWorld(lat, lon);
  let best: { d: number; h: number } | null = null;
  for (const b of pack.buildings) {
    const d = Math.hypot(b.cx - t.x, b.cz - t.z);
    const h = b.topM - b.baseM;
    if (d < 160 && h >= minH && (!best || h > best.h)) best = { d, h };
  }
  console.log(best ? `PASS ${name}: ${best.h.toFixed(0)} m at ${best.d.toFixed(0)} m` : `FAIL ${name}`);
}
near(37.7897, -122.3972, 290, "Salesforce Tower (>=290 m)");
near(37.7952, -122.4028, 210, "Transamerica Pyramid (>=210 m)");
near(37.7845, -122.3963, 180, "181 Fremont / Millennium area (>=180 m)");

// Winding: the renderer's wall normals and ear clipper both assume CCW.
let ccw = 0, cw = 0, degenerate = 0;
for (const b of pack.buildings) {
  const a = signedArea(b.ring);
  if (a > 0) ccw++; else if (a < 0) cw++; else degenerate++;
}
console.log(`winding: ccw=${ccw} cw=${cw} zero=${degenerate}`);

let badVerts = 0;
for (const b of pack.buildings) if (b.ring.length / 2 < 3) badVerts++;
console.log("rings with <3 verts:", badVerts);
