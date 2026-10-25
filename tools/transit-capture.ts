// Saves every live transit feed a city polls, as the raw protobuf, into
// test/fixtures/transit-<name>/, for `?transit=<name>` replays and for the
// decoder check in test/transit.check.ts.
//
//   bun tools/transit-capture.ts --city manhattan --name nyc
//
// The upstreams are fetched directly (no CORS outside a browser). The capture
// time is written to meta.json; a replay freezes the clock there.

import { mkdirSync, writeFileSync } from "node:fs";
import { FEEDS } from "../src/data/transitfeeds";
import { decodeFeed } from "../src/data/gtfsrt";

const args = process.argv.slice(2);
const city = args[args.indexOf("--city") + 1];
const name = args[args.indexOf("--name") + 1];
if (!city || !name) throw new Error("usage: --city <id> --name <fixture>");
const dir = new URL(`../test/fixtures/transit-${name}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const feeds = FEEDS[city] ?? [];
let newest = 0;
for (const f of feeds) {
  const r = await fetch(f.upstream, { headers: { "User-Agent": "flyby-web transit-capture" } });
  const buf = new Uint8Array(await r.arrayBuffer());
  const m = decodeFeed(buf);
  newest = Math.max(newest, m.timestamp);
  writeFileSync(`${dir}${f.key}.pb`, buf);
  console.log(`${f.key}: ${buf.length} bytes, ${m.tripUpdates.length} trip updates, ${m.vehicles.length} vehicles, ts ${m.timestamp}`);
}
writeFileSync(`${dir}meta.json`, JSON.stringify({ city, now: newest * 1000, feeds: feeds.map((f) => f.key) }) + "\n");
