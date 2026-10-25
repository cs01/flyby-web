// Frame PACING on the phone profile: how often a frame is long, and why.
//
// tools/profile.ts measures what a frame costs on average; a phone that is
// "choppy" is usually a phone whose average is fine and whose frames are not
// even. This flies the aeroplane for real (no `?shot`, no pinned camera: the
// drape restitches, the detail ring rebuilds, the traffic steps, the feeds
// poll) at 412x860 dpr 2.6 on the reduced tier, with the frame rate capped to
// the display as a phone's is, and the CPU throttled 4x through the devtools
// protocol to stand in for a mid-range Android's cores.
//
// Reports rAF intervals (mean, p95, p99, frames over 33 and 50 ms), and every
// long frame's CPU breakdown by subsystem plus the long main-thread tasks the
// browser saw outside the frame loop.
//
//   bun tools/jank.ts                          manhattan and sf, 30 s each
//   bun tools/jank.ts --city sf --seconds 20 --throttle 1 --tier full --vp 1280x720x1
//   bun tools/jank.ts --root ../perf-base      another checkout

import { Cdp } from "./cdp";
import { othersBusy } from "./profile";

declare const process: { argv: string[]; exit(code?: number): never };
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const port = Number(arg("port", "5205"));
const profileDir = arg("profile", "/tmp/flyby-perf-profile");
const root = arg("root", new URL("..", import.meta.url).pathname);
const seconds = Number(arg("seconds", "30"));
const throttle = Number(arg("throttle", "4"));
const tier = arg("tier", "reduced");
const [vw, vh, vdpr] = arg("vp", "412x860x2.6").split("x").map(Number);
const cities = arg("city", "manhattan,sf").split(",");
const extra = arg("query", "");

// Noon, a 30% cumulus deck: the clouds are a real cost and a clear sky skips
// most of the march.
const T = Math.floor(Date.parse("2025-06-21T17:00:00Z") / 1000);
const WX = "low:0.3:1400:2300,mid:0:3800:5000,high:0:8500:9400,precip:0";

export interface JankResult {
  city: string;
  frames: number;
  mean: number;
  p95: number;
  p99: number;
  over33: number;
  over50: number;
  worst: number;
  /** Long frames' CPU summed by subsystem, ms. */
  blame: Record<string, number>;
  longTasks: number;
  longTaskMs: number;
}

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], { cwd: root, stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch { /* starting */ }
  await Bun.sleep(100);
}
// Capped: a phone's frames are paced by its display, and pacing is the thing
// being measured.
const cdp = await Cdp.launch({ port: Number(arg("debug-port", "9541")), width: 1280, height: 720, profileDir, uncapped: false });
const results: JankResult[] = [];
try {
  for (const city of cities) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: vdpr, mobile: vdpr > 1.5 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.goto(`http://localhost:${port}/?city=${city}&tier=${tier}&t=${T}&wx=${WX}&gpuprof${extra ? "&" + extra : ""}`);
    await cdp.waitFor("window.flybyShot && window.flybyShot.frames > 30", 240_000, `${city} to load`);
    // Throttled only once loaded: the load itself is not what is choppy, and
    // a 4x-throttled bake of the cloud noise takes a minute.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    await Bun.sleep(3000);
    while (othersBusy(profileDir, 1) >= 15) await Bun.sleep(2000);
    const trace: number[] = [];
    await cdp.eval("window.flybyShot.resetTiming(); window.flybyShot.resetProfile()");
    // The ring holds 600 frames, so read it out every 8 s.
    for (let t = 0; t < seconds; t += 8) {
      await Bun.sleep(Math.min(8, seconds - t) * 1000);
      trace.push(...(await cdp.eval<number[]>("window.flybyShot.frameTrace()")));
      await cdp.eval("window.flybyShot.resetTiming()");
    }
    const j = await cdp.eval<{ longFrames: { ms: number; labels: Record<string, number> }[]; longTasks: { ms: number }[] }>(
      "window.flybyShot.jank()",
    );
    const sorted = [...trace].sort((a, b) => a - b);
    const blame: Record<string, number> = {};
    for (const f of j.longFrames) {
      let named = 0;
      for (const [k, v] of Object.entries(f.labels)) {
        if (k === "frame") continue;
        blame[k] = (blame[k] ?? 0) + v;
        named += v;
      }
      blame["(unlabelled)"] = (blame["(unlabelled)"] ?? 0) + Math.max(0, f.ms - named);
    }
    const r: JankResult = {
      city,
      frames: trace.length,
      mean: trace.reduce((a, b) => a + b, 0) / Math.max(1, trace.length),
      p95: pct(sorted, 0.95),
      p99: pct(sorted, 0.99),
      over33: trace.filter((x) => x > 34).length,
      over50: trace.filter((x) => x > 50).length,
      worst: sorted[sorted.length - 1] ?? 0,
      blame,
      longTasks: j.longTasks.length,
      longTaskMs: j.longTasks.reduce((a, b) => a + b.ms, 0),
    };
    results.push(r);
    console.log(
      `${city.padEnd(10)} ${r.frames} frames  mean ${r.mean.toFixed(1)}  p95 ${r.p95.toFixed(1)}  p99 ${r.p99.toFixed(1)}  ` +
      `>33ms ${r.over33}  >50ms ${r.over50}  worst ${r.worst.toFixed(0)}  long tasks ${r.longTasks} (${r.longTaskMs.toFixed(0)} ms)`,
    );
    console.log("  long frames' CPU: " + Object.entries(blame).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`).join("  "));
  }
} finally {
  cdp.close();
  vite.kill();
}
const out = arg("out", "");
if (out) await Bun.write(out, JSON.stringify(results, null, 1));
