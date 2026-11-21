// Every shader path compiles, checked by actually rendering it.
//
// tools/verify-glsl.ts only catches backticks: nothing in `bun run check`
// compiles a shader, so a merge that left the Pompeii town shader with two
// bare `else` branches passed the whole build and was one deploy away from a
// black town. The shot harness already refuses a page that logs a shader or
// program error (tools/shots.ts FATAL), so one pose per shader path is the
// gate: if any of them fails to compile, this exits non-zero and the build
// stops before vite runs.
//
// One pose per path, not per feature: the city shaders (sf-street), the
// lidar island (alcatraz-flyover), Pompeii by day with its art and columns
// (pompeii-forum-colonnade), Pompeii's lamps at night, the eruption, and the
// phone tier's lean variants (pompeii-forum on the reduced tier is covered by
// the shot's own query).

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POSES = [
  "sf-street",
  "alcatraz-flyover",
  "pompeii-forum-colonnade",
  "pompeii-lamps-abbondanza",
  "eruption-street-1630",
];

const out = mkdtempSync(join(tmpdir(), "flyby-compile-"));
// A port of its own: the default may be a developer's running server, and
// the harness refuses to screenshot someone else's build.
const port = String(5600 + Math.floor(Math.random() * 300));
const t0 = Date.now();
const r = spawnSync("bun", ["tools/shots.ts", "--port", port, "--out", out, "--only", POSES.join(",")], {
  stdio: ["ignore", "inherit", "inherit"],
});
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (r.status !== 0) {
  console.error(`verify-compile: a shader path failed to render (${secs} s); rerun with SHOTS_DUMP=1 for the compiler log`);
  process.exit(1);
}
console.log(`verify-compile: ${POSES.length} shader paths rendered clean in ${secs} s`);
