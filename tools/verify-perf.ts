// The frame-cost gate: `bun run perf`.
//
// Each reference pose is loaded pinned (`?shot`, `?scale=1`, every quality
// feature on) with `?perfbench=6`, and its cost is the FASTEST of several 1 s
// windows. Not the mean: this is a fanless MacBook Air, and under sustained
// load its GPU throttles, so the same frame wanders between 30 and 60 ms over a
// few seconds. Throttling only ever makes a window slower, so the fastest
// window is the closest thing to the frame's own cost, and it is what moves
// when the renderer gets heavier.
//
// The bounds are REGRESSION bounds, measured on this machine (Apple M4,
// ANGLE Metal) and written down as literals with 25% headroom; they are not
// the 16.7 / 33.3 ms the frame rate needs, which the table prints beside each
// pose so the distance to the goal stays visible. A bound read back from the
// code under test could never fail.
//
// VACUITY PROBE: the same poses with `?perfprobe=heavy`, which draws the world
// twice more each frame. It must fail every bound, or the gate is not
// measuring the frame.
//
//   bun run perf
//   bun tools/verify-perf.ts --windows 12

import { Cdp } from "./cdp";
import { PROFILE_POSES, VIEWPORTS, measure, othersBusy } from "./profile";
import { loadavg } from "node:os";

declare const process: { argv: string[]; exit(code?: number): never };
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

interface Ref {
  pose: string;
  viewport: string;
  /** Fastest-window ms measured when the bound was set. */
  measured: number;
  /** What the frame rate needs: 16.7 for the full tier, 33.3 for a phone. */
  goal: number;
}

// Measured 2026-10-24 on an M4 MacBook Air, fastest of 8 windows; see the
// commit that set them. Bound = measured * 1.25.
const REFS: Ref[] = [
  { pose: "manhattan-cruise", viewport: "full-720p", measured: 25.0, goal: 16.7 },
  { pose: "manhattan-street", viewport: "full-720p", measured: 21.0, goal: 16.7 },
  { pose: "sf-street", viewport: "full-720p", measured: 14.8, goal: 16.7 },
  { pose: "sf-street", viewport: "phone", measured: 5.5, goal: 33.3 },
];
const HEADROOM = 1.25;

const port = Number(arg("port", "5207"));
const debugPort = Number(arg("debug-port", "9543"));
const profileDir = arg("profile", "/tmp/flyby-perf-profile");
const windows = Number(arg("windows", "8"));

async function fastest(cdp: Cdp): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < windows; i++) {
    while (othersBusy(profileDir, 1) >= 15) await Bun.sleep(2000);
    await cdp.eval("window.flybyShot.resetTiming()");
    await Bun.sleep(1000);
    const t = await cdp.eval<number[]>("window.flybyShot.benchTrace()");
    if (t.length) best = Math.min(best, t.reduce((a, b) => a + b, 0) / t.length);
  }
  return best;
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
});
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch { /* starting */ }
  await Bun.sleep(100);
}
const cdp = await Cdp.launch({ port: debugPort, width: 1280, height: 720, profileDir, uncapped: true });
let failures = 0;
console.log(`load average ${loadavg()[0].toFixed(2)}`);
try {
  for (const probe of [false, true]) {
    for (const r of REFS) {
      const p = PROFILE_POSES.find((x) => x.name === r.pose)!;
      const v = VIEWPORTS.find((x) => x.name === r.viewport)!;
      const q = ["perfbench=6", probe ? "perfprobe=heavy" : ""].filter(Boolean).join("&");
      await measure(cdp, `http://localhost:${port}`, p, v, q, 36, profileDir);
      const ms = await fastest(cdp);
      const bound = r.measured * HEADROOM;
      const ok = ms <= bound;
      const label = `${r.viewport} ${r.pose}`;
      if (!probe) {
        if (!ok) failures++;
        console.log(
          `${ok ? "ok  " : "FAIL"} ${label.padEnd(30)} ${ms.toFixed(1)} ms (bound ${bound.toFixed(1)}, ` +
          `goal ${r.goal}${ms <= r.goal ? ", met" : `, ${(ms - r.goal).toFixed(1)} over`})`,
        );
      } else {
        if (ok) failures++;
        console.log(`${ok ? "PROBE-FAIL" : "  ok"} vacuity: ?perfprobe=heavy ${label.padEnd(26)} ${ms.toFixed(1)} ms against ${bound.toFixed(1)}`);
      }
    }
  }
} finally {
  cdp.close();
  vite.kill();
}
console.log(failures ? `\nperf: ${failures} FAILED` : "\nperf: all checks passed");
if (failures) process.exit(1);
