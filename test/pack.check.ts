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

// Landmarks must land where they really are: the tallest building inside
// `radius` of the surveyed point, in [minH, maxH]. The ceiling and the tight
// radius are what make a miss possible: the old 160 m disc around 181 Fremont
// reached the 326 m Salesforce Tower 158 m west, and its point (37.7845) was
// 600 m south of the tower, so it printed FAIL on every run while exiting 0.
let failures = 0;
function near(lat: number, lon: number, minH: number, maxH: number, radius: number, name: string): boolean {
  const t = o.toWorld(lat, lon);
  let best: { d: number; h: number } | null = null;
  for (const b of pack.buildings) {
    const d = Math.hypot(b.cx - t.x, b.cz - t.z);
    const h = b.topM - b.baseM;
    if (d < radius && h >= minH && h <= maxH && (!best || h > best.h)) best = { d, h };
  }
  return best !== null;
}
function landmark(lat: number, lon: number, minH: number, maxH: number, radius: number, name: string): void {
  const ok = near(lat, lon, minH, maxH, radius, name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (${minH}-${maxH} m within ${radius} m)`);
  if (!ok) failures++;
}
landmark(37.7897, -122.3972, 290, 340, 40, "Salesforce Tower");
landmark(37.7952, -122.4028, 210, 270, 40, "Transamerica Pyramid");
landmark(37.7898, -122.3954, 210, 260, 40, "181 Fremont");
landmark(37.7905, -122.3962, 180, 210, 40, "Millennium Tower");
// Vacuity: the old 181 Fremont point must find nothing, or the radius and the
// ceiling are not discriminating.
if (near(37.7845, -122.3963, 210, 260, 40, "")) {
  console.log("PROBE-FAIL vacuity: a landmark 600 m off still found a tower");
  failures++;
}

// Winding: the renderer's wall normals and ear clipper both assume CCW.
let ccw = 0, cw = 0, degenerate = 0;
for (const b of pack.buildings) {
  const a = signedArea(b.ring);
  if (a > 0) ccw++; else if (a < 0) cw++; else degenerate++;
}
console.log(`winding: ccw=${ccw} cw=${cw} zero=${degenerate}`);
if (cw || degenerate) failures++;

let badVerts = 0;
for (const b of pack.buildings) if (b.ring.length / 2 < 3) badVerts++;
console.log("rings with <3 verts:", badVerts);
if (badVerts) failures++;
if (failures) { console.log(`pack: ${failures} FAILED`); process.exit(1); }
