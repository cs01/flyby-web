// A/B frame cost: the same poses served from two checkouts, loaded
// alternately in one Chrome, so drift on a shared machine lands on both sides.
//
//   bun tools/abtest.ts --a ../perf-base --b . --only sf-street,manhattan-cruise [--viewport phone] [--rounds 3]
//   bun tools/abtest.ts --a . --b . --qa "" --qb "qlevel=2"     (one checkout, two queries)
//
// Prints, per pose, the frame cost of each side (the median over rounds of
// each round's mean frame interval) and the difference, with the spread across rounds.

import { Cdp } from "./cdp";
import { PROFILE_POSES, VIEWPORTS, measure, othersBusy } from "./profile";

declare const process: { argv: string[]; exit(code?: number): never };
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

async function serve(root: string, port: number): Promise<ReturnType<typeof Bun.spawn>> {
  const p = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  return p;
}

const profileDir = arg("profile", "/tmp/flyby-perf-profile");
const rootA = arg("a", "."), rootB = arg("b", ".");
const qa = arg("qa", ""), qb = arg("qb", "");
const rounds = Number(arg("rounds", "4"));
const frames = Number(arg("frames", "180"));
const view = VIEWPORTS.find((v) => v.name === arg("viewport", "full-720p"))!;
const poses = PROFILE_POSES.filter((p) => arg("only", "sf-street").split(",").includes(p.name));
const va = await serve(rootA, 5205);
const vb = rootB === rootA ? null : await serve(rootB, 5206);
const cdp = await Cdp.launch({ port: 9541, width: 1280, height: 720, profileDir, uncapped: true });
const extra = (q: string) => ["gpuprof", `perfbench=${arg("bench", "6")}`, q].filter(Boolean).join("&");
try {
  for (const p of poses) {
    const a: number[] = [], b: number[] = [];
    for (let r = 0; r < rounds; r++) {
      for (const side of r % 2 ? ["b", "a"] : ["a", "b"]) {
        const base = side === "a" || !vb ? "http://localhost:5205" : "http://localhost:5206";
        const m = await measure(cdp, base, p, view, extra(side === "a" ? qa : qb), frames, profileDir);
        (side === "a" ? a : b).push(m.frameMs.mean);
      }
    }
    // The median of the rounds, not the mean: a round that lands on another
    // agent's render is a few times slower, and one of those in four would
    // otherwise be most of the answer.
    const mean = (x: number[]) => [...x].sort((p, q) => p - q)[x.length >> 1];
    const spread = (x: number[]) => Math.max(...x) - Math.min(...x);
    console.log(
      `${view.name} ${p.name.padEnd(24)} A ${mean(a).toFixed(2)} (±${spread(a).toFixed(2)})  ` +
      `B ${mean(b).toFixed(2)} (±${spread(b).toFixed(2)})  B-A ${(mean(b) - mean(a)).toFixed(2)} ms  ` +
      `busy ${othersBusy(profileDir, 1).toFixed(0)}  [${a.map((v) => v.toFixed(1)).join(" ")} | ${b.map((v) => v.toFixed(1)).join(" ")}]`,
    );
  }
} finally {
  cdp.close();
  va.kill();
  vb?.kill();
}
