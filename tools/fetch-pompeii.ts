// Fetches the raw OSM for the Pompeii excavation once, into tools/.cache/pompeii/.
// Separate from the bake so a bake can be rerun offline as often as it takes:
// Overpass is donated infrastructure and one answer for a fixed bbox is enough.
import { mkdirSync, existsSync, writeFileSync } from "node:fs";

const OUT = new URL("./.cache/pompeii/", import.meta.url).pathname;
const BBOX = "40.7440,14.4770,40.7545,14.4975";
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
