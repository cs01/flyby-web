// Where the frame goes: per-pass GPU time and per-subsystem CPU time, per pose
// and per tier.
//
// Frame time says whether a frame is slow; it cannot say what made it slow,
// and every feature in this renderer was measured alone. This loads a set of
// pinned poses (`?shot` determinism, `?scale=1`, the frame rate uncapped) with
// `?gpuprof`, which brackets every pass in an EXT_disjoint_timer_query_webgl2
// query (render/gpuprof.ts), and prints a table of label -> ms.
//
//   bun tools/profile.ts                              every pose, both tiers
//   bun tools/profile.ts --only sf-street --tier full
//   bun tools/profile.ts --objects                    main pass split by group
//   bun tools/profile.ts --out a.json; ... --compare a.json
//
// GPU time is the number to read. Frame time is reported beside it, but
// uncapped headless Chrome queues frames ahead and pays for them at sync
// points, so the mean frame interval tracks GPU time only on a GPU-bound pose.
//
// A shared GPU makes every number here a lie, so the load average and any
// other headless Chrome are printed with each run; see `machineLoad`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { Cdp } from "./cdp";

declare const process: { argv: string[]; exit(code?: number): never };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** This harness's own Chrome profile, which `othersBusy` leaves out. */
let PROFILE_DIR = "/tmp/flyby-perf-profile";

const D = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const CLEAR = "low:0:900:2100,mid:0:3800:5000,high:0:8500:9400,precip:0";
const CUMULUS = "low:0.3:1400:2300,mid:0:3800:5000,high:0:8500:9400,precip:0";
const OVERCAST = "low:0.97:750:2100,mid:0:3800:5000,high:0:8500:9400,precip:0";

export interface ProfilePose {
  name: string;
  city: string;
  lat: number;
  lon: number;
  altM: number;
  hdgDeg: number;
  pitchDeg: number;
  t: number;
  wx: string;
  query?: string;
}

/**
 * Cruise over each city under fair-weather cumulus (the clouds are a real
 * cost and a clear sky skips most of the march), street level in the car in
 * each, the two night cases, and an overcast deck.
 */
export const PROFILE_POSES: ProfilePose[] = [
  { name: "manhattan-cruise", city: "manhattan", lat: 40.7350, lon: -73.9950, altM: 450, hdgDeg: 25, pitchDeg: -8,
    t: D("2025-06-21T17:00:00Z"), wx: CUMULUS },
  { name: "sf-cruise", city: "sf", lat: 37.7750, lon: -122.4300, altM: 450, hdgDeg: 45, pitchDeg: -8,
    t: D("2025-06-21T19:30:00Z"), wx: CUMULUS },
  { name: "chicago-cruise", city: "chicago", lat: 41.8650, lon: -87.6400, altM: 450, hdgDeg: 20, pitchDeg: -8,
    t: D("2025-06-21T18:00:00Z"), wx: CUMULUS },
  { name: "manhattan-street", city: "manhattan", lat: 40.75284, lon: -73.98928, altM: 20, hdgDeg: 209, pitchDeg: 0,
    t: D("2025-06-21T17:00:00Z"), wx: CLEAR, query: "drive=1" },
  { name: "sf-street", city: "sf", lat: 37.7885, lon: -122.4222, altM: 58.8, hdgDeg: 5, pitchDeg: -2,
    t: D("2025-06-21T18:30:00Z"), wx: CLEAR, query: "drive=1" },
  { name: "chicago-street", city: "chicago", lat: 41.8800, lon: -87.63233, altM: 190, hdgDeg: 0, pitchDeg: 0,
    t: D("2025-06-21T18:00:00Z"), wx: CLEAR, query: "drive=1" },
  { name: "chicago-night", city: "chicago", lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T03:30:00Z"), wx: CLEAR },
  { name: "manhattan-street-night", city: "manhattan", lat: 40.75284, lon: -73.98928, altM: 20, hdgDeg: 209, pitchDeg: 0,
    t: D("2025-06-22T02:30:00Z"), wx: CLEAR, query: "drive=1" },
  { name: "manhattan-overcast", city: "manhattan", lat: 40.7000, lon: -74.0200, altM: 380, hdgDeg: 30, pitchDeg: 4,
    t: D("2025-06-21T17:00:00Z"), wx: OVERCAST },
];

/** A viewport: CSS size and device pixel ratio, as the page is told it. */
export interface Viewport {
  name: string;
  tier: "full" | "reduced";
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
}

export const VIEWPORTS: Viewport[] = [
  { name: "full-720p", tier: "full", width: 1280, height: 720, dpr: 1, mobile: false },
  { name: "full-laptop", tier: "full", width: 1728, height: 1000, dpr: 2, mobile: false },
  { name: "phone", tier: "reduced", width: 412, height: 860, dpr: 2.6, mobile: true },
];

export function poseUrl(base: string, p: ProfilePose, tier: string, extra: string): string {
  const q = new URLSearchParams({
    city: p.city,
    cam: `${p.lat},${p.lon},${p.altM},${p.hdgDeg},${p.pitchDeg}`,
    t: String(p.t),
    wx: p.wx,
    scale: "1",
    shot: "1",
    tier,
  });
  return `${base}/?${q.toString()}${p.query ? "&" + p.query : ""}${extra ? "&" + extra : ""}`;
}

/** The 1-minute load average and every other headless Chrome on the machine. */
export async function machineLoad(profileDir: string): Promise<{ load: number; others: number }> {
  const ps = Bun.spawnSync(["ps", "-axo", "pcpu=,command="]).stdout.toString();
  let others = 0;
  for (const line of ps.split("\n")) {
    if (!line.includes("--headless") || !line.includes("Google Chrome") || line.includes(profileDir)) continue;
    // Only the browser process carries --user-data-dir; helpers repeat other flags.
    if (line.includes("--user-data-dir") && !line.includes("--type=")) others++;
  }
  return { load: loadavg()[0], others };
}

export interface PoseResult {
  pose: string;
  viewport: string;
  frameMs: { mean: number; p99: number; median?: number };
  gpuTotal: number;
  gpu: Record<string, number>;
  cpu: Record<string, number>;
  frames: number;
  load: number;
  attrib?: { base: number; drift: number; floor: number; delta: Record<string, number> };
}

/** Start a dev server on `port` and a headless Chrome. */
export async function startHarness(port: number, debugPort: number, profileDir: string, root = ""):
  Promise<{ base: string; cdp: Cdp; stop: () => void }> {
  const base = `http://localhost:${port}`;
  // Always a fresh server, never one found on the port: vite.config.ts stops
  // the watcher looking inside .claude/worktrees, so a dev server started in
  // a worktree keeps serving the main.ts it first transformed, and a profile
  // of it silently measures the build from before the edit.
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) });
    throw new Error(`port ${port} is already serving; stop it (it may be a stale build) or pass --port`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`port ${port}`)) throw err;
  }
  const vite = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
    cwd: root || new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  const cdp = await Cdp.launch({ port: debugPort, width: 1280, height: 720, profileDir, uncapped: true });
  return { base, cdp, stop: () => { cdp.close(); vite.kill(); } };
}

/**
 * CPU of every other headless Chrome's process tree, percent of one core,
 * sampled three times a second apart and the highest kept. Its GPU process is
 * in the tree, and a busy GPU process means the GPU is shared.
 */
export function othersBusy(profileDir: string, samples = 3): number {
  let worst = 0;
  for (let k = 0; k < samples; k++) {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,pcpu=,command="]).stdout.toString().split("\n");
    const roots = new Set<string>();
    const rows = ps.map((l) => l.trim().split(/\s+/, 4)).filter((r) => r.length === 4);
    for (const [pid, , , cmd] of rows) {
      if (cmd.includes("Google Chrome") && cmd.includes("--headless") && !cmd.includes("--type=") &&
          !cmd.includes(profileDir)) roots.add(pid);
    }
    let sum = 0;
    for (const [pid, ppid, pcpu] of rows) if (roots.has(pid) || roots.has(ppid)) sum += Number(pcpu);
    worst = Math.max(worst, sum);
    if (k < samples - 1) Bun.sleepSync(1000);
  }
  return worst;
}

/**
 * Wait (up to `maxMs`) until no other headless Chrome is busy. An idle one is
 * tolerated: another agent's harness sits between captures for minutes at a
 * time, and only its rendering competes for the GPU.
 */
export async function waitForQuiet(profileDir: string, maxMs = 600_000): Promise<number> {
  const until = Date.now() + maxMs;
  for (;;) {
    const busy = othersBusy(profileDir);
    if (busy < 15 || Date.now() > until) return busy;
    await Bun.sleep(5000);
  }
}

export async function measure(
  cdp: Cdp, base: string, p: ProfilePose, v: Viewport, extra: string, frames: number, profileDir: string,
): Promise<PoseResult> {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: v.width, height: v.height, deviceScaleFactor: v.dpr, mobile: v.mobile,
  });
  cdp.problems.length = 0;
  const busy = await waitForQuiet(profileDir);
  if (busy >= 15) console.log(`WARNING: another headless Chrome still at ${busy.toFixed(0)}% CPU after 10 min`);
  await cdp.goto(poseUrl(base, p, v.tier, extra));
  await cdp.waitFor("window.flybyShot", 240_000, `${p.name} to load`);
  await cdp.waitFor("window.flybyShot.frames > 60", 60_000, `${p.name} to settle`);
  await cdp.waitFor("window.flybyShot.drapePending !== true", 120_000, `${p.name} detail drape`);
  await cdp.waitFor("!(window.__flybyMaterialsPending > 0)", 120_000, `${p.name} materials`);
  // Shader compiles, mip generation and the city shadow map's first draw all
  // land in the first frames after the load; none of them is steady state.
  const at = await cdp.eval<number>("window.flybyShot.frames");
  await cdp.waitFor(`window.flybyShot.frames > ${at + 150}`, 60_000, `${p.name} warm-up`);
  const { load } = await machineLoad(profileDir);
  await cdp.eval("window.flybyShot.resetTiming(); window.flybyShot.resetProfile()");
  await cdp.waitFor(`window.flybyShot.timed > ${frames}`, 120_000, `${p.name} sample`);
  const frameMs = await cdp.eval<{ mean: number; p99: number; median?: number }>("window.flybyShot.frameMs()");
  frameMs.median = median(await cdp.eval<number[]>("window.flybyShot.frameTrace()"));
  const r = await cdp.eval<{ frames: number; gpu: Record<string, number>; cpu: Record<string, number> }>(
    "window.flybyShot.profile()",
  );
  const bad = cdp.problems.filter((m) => /Shader Error|not compiled|program not valid|Uncaught/i.test(m));
  if (bad.length) throw new Error(`${p.name}: page is broken: ${bad[0]}`);
  const gpuTotal = Object.values(r.gpu).reduce((a, b) => a + b, 0);
  return { pose: p.name, viewport: v.name, frameMs, gpuTotal, gpu: r.gpu, cpu: r.cpu, frames: r.frames, load };
}

/** Everything tools/profile.ts can take away, passes first, then scene groups. */
export const TOGGLES = [
  "shadow", "aircraft", "ao", "ssr", "clouds", "cloudshadow", "bloom", "skyprobe",
  "terrain", "buildings", "roads", "pavement", "bridges", "lamps", "traffic", "parkedcars",
  "foliage", "shrubs", "live", "airtraffic", "transit", "sky",
];

/**
 * Mean frame interval over `frames` frames with `off` switched off: the
 * throughput, which is what decides whether the frame rate holds.
 *
 * Not the median, and not with the GPU drained (`--sync`, `?perfsync`). Both
 * were tried. Uncapped, frames race and stall, so the median lands in the
 * race. Drained every frame, the GPU idles while the CPU works and the M4 then
 * flips between two clock states for ~15 s at a time: chicago-street read a
 * 20 ms median for one stretch and 54 ms for the next with nothing else on the
 * machine. Undrained, the mean of 3 s windows on the same pose held 16.7 to
 * 17.3 ms over fourteen windows in a row.
 */
async function frameWith(cdp: Cdp, off: string[], frames: number): Promise<number> {
  await cdp.eval(`window.flybyShot.setOff(${JSON.stringify(off)})`);
  const at = await cdp.eval<number>("window.flybyShot.frames");
  await cdp.waitFor(`window.flybyShot.frames > ${at + 20}`, 60_000, "toggle settle");
  // Retried while another agent's Chrome is rendering: its bursts are a few
  // seconds long and doubled this page's frame time for exactly that long
  // (24 ms against 54 ms medians on chicago-cruise, alternating), which a
  // median over one sample cannot see past.
  for (let tries = 0; ; tries++) {
    while (othersBusy(PROFILE_DIR, 1) >= 15) await Bun.sleep(2000);
    await cdp.eval("window.flybyShot.resetTiming()");
    await cdp.waitFor(`window.flybyShot.timed > ${frames}`, 120_000, "toggle sample");
    const t = await cdp.eval<number[]>("window.flybyShot.frameTrace()");
    const m = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
    if (othersBusy(PROFILE_DIR, 1) < 15 || tries >= 5) return m;
  }
}

export function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}

/**
 * What each pass and group costs, as the frame time it gives back when it is
 * taken away. Called after `measure` has loaded and warmed the pose. The base
 * is sampled before and after the sweep, and the spread between the two is
 * the noise floor every delta in the row should be read against.
 */
export async function attribute(cdp: Cdp, frames: number, base: string[] = []):
  Promise<{ base: number; drift: number; floor: number; delta: Record<string, number> }> {
  const present = await cdp.eval<string[]>("window.flyby.scene.children.map((c) => c.name)");
  const toggles = TOGGLES.filter((t) => TOGGLES.indexOf(t) < 8 || present.includes(t)).filter((t) => !base.includes(t));
  // Every toggle is SANDWICHED between two base samples, and kept only when
  // the two agree within 8%. Something on this machine (the other agent's
  // Chrome in bursts too short for ps to see, or the GPU changing clock state)
  // doubles the frame time for seconds at a time, and a sweep that sampled the
  // base once read deltas of -30 ms for things that cost nothing.
  const bases: number[] = [];
  const delta: Record<string, number> = {};
  const sandwich = async (off: string[]): Promise<number> => {
    let best = { spread: Infinity, d: 0 };
    for (let tries = 0; tries < 5; tries++) {
      const a1 = await frameWith(cdp, base, frames);
      const t = await frameWith(cdp, off, frames);
      const a2 = await frameWith(cdp, base, frames);
      const spread = Math.abs(a1 - a2) / Math.min(a1, a2);
      if (spread < best.spread) best = { spread, d: (a1 + a2) / 2 - t };
      if (spread < 0.08) {
        bases.push(a1, a2);
        break;
      }
    }
    return best.d;
  };
  for (const t of toggles) delta[t] = await sandwich([...base, t]);
  const offAll = await sandwich([...base, ...toggles]);
  const b = median(bases.length ? bases : [await frameWith(cdp, base, frames)]);
  const floor = b - offAll;
  return { base: b, drift: bases.length ? Math.max(...bases) - Math.min(...bases) : 0, floor, delta };
}

function table(results: PoseResult[], key: "gpu" | "cpu", compare: PoseResult[] | null): string {
  const labels = new Set<string>();
  for (const r of results) for (const k of Object.keys(r[key])) labels.add(k);
  const order = [...labels].sort((a, b) => {
    const s = (l: string) => results.reduce((x, r) => x + (r[key][l] ?? 0), 0);
    return s(b) - s(a);
  });
  const old = (r: PoseResult) => compare?.find((c) => c.pose === r.pose && c.viewport === r.viewport);
  const cell = (v: number | undefined, was: number | undefined): string => {
    const now = v === undefined ? "-" : v.toFixed(2);
    if (!compare) return now.padStart(8);
    const w = was === undefined ? "-" : was.toFixed(2);
    return `${w}>${now}`.padStart(13);
  };
  const w = compare ? 13 : 8;
  const head = "".padEnd(22) + results.map((r) => r.pose.slice(0, w - 1).padStart(w)).join("");
  const lines = [head];
  if (key === "gpu") {
    lines.push("TOTAL gpu".padEnd(22) + results.map((r) => cell(r.gpuTotal, old(r)?.gpuTotal)).join(""));
    lines.push("frame median".padEnd(22) + results.map((r) => cell(r.frameMs.median, old(r)?.frameMs.median)).join(""));
    lines.push("frame mean".padEnd(22) + results.map((r) => cell(r.frameMs.mean, old(r)?.frameMs.mean)).join(""));
    lines.push("frame p99".padEnd(22) + results.map((r) => cell(r.frameMs.p99, old(r)?.frameMs.p99)).join(""));
  }
  for (const l of order) {
    if (results.every((r) => (r[key][l] ?? 0) < 0.03)) continue;
    lines.push(l.slice(0, 21).padEnd(22) + results.map((r) => cell(r[key][l], old(r)?.[key][l])).join(""));
  }
  return lines.join("\n");
}

/** Rows: what was taken away; columns: poses; cells: ms the frame gave back. */
function attribTable(results: PoseResult[], compare: PoseResult[] | null): string {
  const rs = results.filter((r) => r.attrib);
  if (!rs.length) return "";
  const old = (r: PoseResult) => compare?.find((c) => c.pose === r.pose && c.viewport === r.viewport)?.attrib;
  const w = compare ? 13 : 8;
  const cell = (v: number | undefined, was: number | undefined): string => {
    const now = v === undefined ? "-" : v.toFixed(2);
    if (!compare) return now.padStart(w);
    return `${was === undefined ? "-" : was.toFixed(2)}>${now}`.padStart(w);
  };
  const lines = ["".padEnd(22) + rs.map((r) => r.pose.slice(0, w - 1).padStart(w)).join("")];
  lines.push("base (mean ms)".padEnd(22) + rs.map((r) => cell(r.attrib!.base, old(r)?.base)).join(""));
  lines.push("drift".padEnd(22) + rs.map((r) => cell(r.attrib!.drift, old(r)?.drift)).join(""));
  lines.push("everything off".padEnd(22) + rs.map((r) => cell(r.attrib!.floor, old(r)?.floor)).join(""));
  for (const t of TOGGLES) {
    if (rs.every((r) => r.attrib!.delta[t] === undefined)) continue;
    lines.push(`- ${t}`.padEnd(22) + rs.map((r) => cell(r.attrib!.delta[t], old(r)?.delta[t])).join(""));
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const port = Number(arg("port", "5205"));
  const debugPort = Number(arg("debug-port", "9541"));
  const profileDir = arg("profile", "/tmp/flyby-perf-profile");
  PROFILE_DIR = profileDir;
  const only = arg("only", "");
  const tier = arg("viewport", "");
  const frames = Number(arg("frames", "180"));
  const extra = [`gpuprof=${has("objects") ? "objects" : arg("mode", "")}`, has("sync") ? "perfsync" : "", arg("query", "")].filter(Boolean).join("&");
  const outFile = arg("out", "");
  const compareFile = arg("compare", "");
  const compare = compareFile ? (JSON.parse(readFileSync(compareFile, "utf8")) as PoseResult[]) : null;

  const poses = only ? PROFILE_POSES.filter((p) => only.split(",").includes(p.name)) : PROFILE_POSES;
  const views = tier ? VIEWPORTS.filter((v) => tier.split(",").includes(v.name)) : VIEWPORTS;
  if (!poses.length || !views.length) throw new Error("no pose or viewport matches");

  const m = await machineLoad(profileDir);
  console.log(`load average ${m.load.toFixed(2)}, ${m.others} other headless Chrome(s)`);
  if (m.others > 0) console.log("WARNING: another headless Chrome is running; GPU numbers are shared");

  // `--root DIR` serves another checkout, so a baseline can be profiled with
  // this harness while the tree under it carries the fix.
  const h = await startHarness(port, debugPort, profileDir, arg("root", ""));
  const results: PoseResult[] = [];
  try {
    for (const v of views) {
      const vr: PoseResult[] = [];
      for (const p of poses) {
        const r = await measure(h.cdp, h.base, p, v, extra, frames, profileDir);
        if (has("attrib") && (!arg("attrib-viewport", "") || arg("attrib-viewport", "").split(",").includes(v.name))) {
          const base = arg("base-off", "").split(",").filter(Boolean);
          const a = await attribute(h.cdp, frames, base);
          r.attrib = a;
          console.log(
            `${p.name} attribution: base ${a.base.toFixed(2)} ms (drift ${a.drift.toFixed(2)}), ` +
            `everything off ${a.floor.toFixed(2)}\n  ` +
            Object.entries(a.delta).sort((x, y) => y[1] - x[1])
              .map(([k, d]) => `${k} ${d.toFixed(2)}`).join("  "),
          );
        }
        vr.push(r);
        results.push(r);
        console.log(
          `${v.name.padEnd(12)} ${p.name.padEnd(24)} gpu ${r.gpuTotal.toFixed(2).padStart(6)} ms  ` +
          `frame ${(r.frameMs.median ?? 0).toFixed(2).padStart(6)} median ${r.frameMs.mean.toFixed(2).padStart(6)} mean ` +
          `${r.frameMs.p99.toFixed(1).padStart(6)} p99  ` +
          `cpu ${(r.cpu.frame ?? 0).toFixed(2)} ms  load ${r.load.toFixed(2)}  (${r.frames} frames)`,
        );
      }
      if (has("attrib")) {
        console.log(`\n== ${v.name} (tier ${v.tier}, ${v.width}x${v.height} dpr ${v.dpr}): ms given back by taking each away ==`);
        console.log(attribTable(vr, compare));
      }
      console.log(`\n== ${v.name}: GPU timer queries per pass (these overlap on Apple GPUs; read as relative) ==`);
      console.log(table(vr, "gpu", compare));
      console.log(`\n== ${v.name}: CPU ms per subsystem ==`);
      console.log(table(vr, "cpu", compare));
      console.log("");
    }
  } finally {
    h.stop();
  }
  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(results, null, 2));
    console.log(`-> ${outFile}`);
  }
}

if (import.meta.main) await main();
