// Fetches the raw OSM for an ancient town's excavation once, into tools/.cache/<town>/.
//   bun tools/fetch-pompeii.ts [pompeii|herculaneum] [--force]
// Separate from the bake so a bake can be rerun offline as often as it takes:
// Overpass is donated infrastructure and one answer for a fixed bbox is enough.
import { mkdirSync, existsSync, writeFileSync } from "node:fs";

// The Herculaneum box reaches the Villa of the Papyri to the north-west and the
// buried theatre to the north as well as the open excavation.
const BOXES: Record<string, string> = {
  pompeii: "40.7440,14.4770,40.7545,14.4975",
  herculaneum: "40.8030,14.3410,40.8105,14.3525",
};
const TOWN = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "pompeii";
const BBOX = BOXES[TOWN];
if (!BBOX) throw new Error(`unknown town ${TOWN}`);
const OUT = new URL(`./.cache/${TOWN}/`, import.meta.url).pathname;
const QUERY =
  `[out:json][timeout:180];(way(${BBOX});relation(${BBOX});node(${BBOX})[name];` +
  `node(${BBOX})[amenity];node(${BBOX})[historic];);out body;>;out skel qt;`;
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dest = OUT + "raw.json";
  if (existsSync(dest) && !process.argv.includes("--force")) {
    console.log(`cached: ${dest}`);
    return;
  }
  let wait = 5000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "flyby-web-baker" },
        body: "data=" + encodeURIComponent(QUERY),
        signal: AbortSignal.timeout(200_000),
      });
      const text = await res.text();
      if (res.ok && text.includes('"elements"')) {
        writeFileSync(dest, text);
        console.log(`ok ${ep}: ${text.length} bytes`);
        return;
      }
      console.log(`${ep}: HTTP ${res.status}`);
    } catch (e) {
      console.log(`${ep}: ${e}`);
    }
    await new Promise((r) => setTimeout(r, wait));
    wait *= 2;
  }
  throw new Error("overpass: every attempt failed");
}

await main();
