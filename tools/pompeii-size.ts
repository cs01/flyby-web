// Triangle and byte counts of the Pompeii town build, full and lean, on the flat ground the gate uses.
//   bun tools/pompeii-size.ts
import { readFileSync } from "node:fs";
import { parsePompeii } from "../src/data/pompeii";
import { buildPompeii, type PompeiiModel } from "../src/render/pompeiimesh";

const data = parsePompeii(readFileSync(new URL("../public/landmarks/pompeii.json", import.meta.url), "utf8"));
// The gate's own sloping test ground (test/pompeii.check.ts), so the numbers match its budget lines.
const flat = (_x: number, z: number): number => 20 - z * 0.02;
for (const lean of [false, true]) {
  const m: PompeiiModel = buildPompeii({ data, groundAt: flat, lean });
  const parts = [m.mesh, m.floor, m.streets];
  const bytes = parts.reduce((s, x) => s + x.position.byteLength + x.normal.byteLength + x.colour.byteLength + x.surf.byteLength + x.wall.byteLength + x.index.byteLength, 0);
  const tris = parts.reduce((s, x) => s + x.index.length / 3, 0);
  console.log(`${lean ? "lean" : "full"}: ${tris.toLocaleString()} triangles, ${(bytes / 1048576).toFixed(2)} MB`);
}
