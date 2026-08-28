// Writes public/cities/index.json: the ids that actually have a baked building
// pack. The start screen uses it to mark which cities have a skyline, so a
// terrain-only city is labelled rather than looking like a bug.
//
// Generated, never hand-edited: a hand-kept list drifts the moment someone
// bakes a city and forgets, and then the menu lies.

const dir = new URL("../public/cities/", import.meta.url).pathname;
const { readdirSync, statSync } = await import("node:fs");

const ids = readdirSync(dir)
  .filter((f) => f.endsWith(".city"))
  // A truncated pack from an interrupted bake is worse than no pack: the menu
  // would promise a skyline the renderer then fails to parse.
  .filter((f) => statSync(dir + f).size > 1024)
  .map((f) => f.replace(/\.city$/, ""))
  .sort();

await Bun.write(dir + "index.json", JSON.stringify(ids));
console.log(`city-index: ${ids.length} packs -> ${dir}index.json`);
console.log(ids.join(", "));
