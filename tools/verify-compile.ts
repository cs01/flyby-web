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
// (pompeii-forum-colonnade), Pompeii's lamps at night, its water (the baths' rooms,
// pools, jets and steam), the eruption, and the
// phone tier's lean variants (pompeii-fountain-phone for the water's; pompeii-forum on the reduced tier is covered by
// the shot's own query).

import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const POSES = [
  "sf-street",
  "alcatraz-flyover",
  "pompeii-forum-colonnade",
  "pompeii-lamps-abbondanza",
  "pompeii-baths-caldarium",
  "pompeii-fountain-phone",
  "eruption-street-1630",
];

const out = mkdtempSync(join(tmpdir(), "flyby-compile-"));
// Ports and a Chrome profile of its own: the defaults are shared with every
// other shots run, and a second Chrome on the same debug port or profile made
// this time out while parallel work was rendering. The profile slots below are
// fixed (not per run) so their tile caches stay warm between builds.
const port = String(5600 + Math.floor(Math.random() * 300));
// Chrome holds a profile while it runs (SingletonLock) and refuses a second
// instance on it, which made a build right after another build fail to launch.
// A few fixed slots keep the tile cache warm without sharing a live profile.
// The lock is a symlink to a host-pid name that dangles, so only lstat sees it.
const locked = (dir: string): boolean => !!lstatSync(`${dir}/SingletonLock`, { throwIfNoEntry: false });
const slot = [0, 1, 2, 3].map((i) => `/tmp/flyby-compile-profile-${i}`).find((d) => !locked(d));
if (!slot) {
  console.error("verify-compile: all four Chrome profile slots are in use; is another build running?");
  process.exit(1);
}
const debugPort = String(9500 + Math.floor(Math.random() * 300));
const t0 = Date.now();
const r = spawnSync("bun", ["tools/shots.ts", "--port", port, "--debug-port", debugPort, "--profile", slot, "--out", out, "--only", POSES.join(",")], {
  stdio: ["ignore", "inherit", "inherit"],
});
const secs = ((Date.now() - t0) / 1000).toFixed(0);
if (r.status !== 0) {
  console.error(`verify-compile: a pose failed to render (${secs} s): a shader error, or the harness itself (see above); SHOTS_DUMP=1 prints the page log`);
  process.exit(1);
}
console.log(`verify-compile: ${POSES.length} shader paths rendered clean in ${secs} s`);
