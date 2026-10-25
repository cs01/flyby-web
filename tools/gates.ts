// Every gate, serially, with one vite port, one Chrome debug port and one
// Chrome profile: `bun run gates`.
//
// The rendered gates each start their own vite and headless Chrome, so two at
// once share the GPU and the frame-cost and timing-sensitive ones read each
// other's load. Serial is the only order that measures anything. One profile
// means the IndexedDB tile cache is filled by the first gate and reused by the
// rest instead of every gate refetching the city.
//
// Each gate prints `ok  ` / `FAIL` per check and `  ok vacuity:` /
// `PROBE-FAIL vacuity:` per probe (a probe is the old behaviour in the same
// binary and must FAIL the check). The summary counts those lines, and a gate
// that exits 0 having printed no check at all is reported as EMPTY, not ok:
// a gate whose parser stops matching would otherwise read green forever.
//
//   bun run gates                       (check, then every rendered gate)
//   bun run gates --only glass,water    (a subset, in the order given)
//   bun run gates --skip perf

import { mkdirSync, writeFileSync } from "node:fs";

declare const process: { argv: string[]; exit(code?: number): never };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const port = arg("port", "5211");
const debugPort = arg("debug-port", "9581");
const profile = arg("profile", "/tmp/flyby-gates-profile");
const logDir = arg("logs", "shots/gates");

interface Gate { name: string; cmd: string[]; rendered: boolean; claim: string }

const R = (name: string, tool: string, claim: string): Gate => ({
  name, rendered: true, claim,
  cmd: ["bun", `tools/${tool}.ts`, "--port", port, "--debug-port", debugPort, "--profile", profile],
});

const GATES: Gate[] = [
  { name: "check", rendered: false, cmd: ["bun", "run", "check"], claim: "typecheck, unit suites, pack/land/road/aircraft/glsl verifiers" },
  R("water", "verify-water", "water reflects, glints and does not tile"),
  R("ground", "verify-ground", "ground texture detail and no tiling"),
  R("shadow", "verify-shadow", "sun shadows land where they should"),
  R("clouds", "verify-clouds", "volumetric clouds shape, light and move"),
  R("night", "verify-night", "night city lights"),
  R("buildings", "verify-buildings", "facade, roof and silhouette detail"),
  R("skyglow", "verify-skyglow", "urban sky glow at night"),
  R("farcolour", "verify-farcolour", "far terrain colour matches near"),
  R("glass", "verify-glass", "glass towers reflect"),
  R("bounce", "verify-street", "street-level bounce light"),
  R("perf", "verify-perf", "frame cost bounds per pose"),
];

const only = arg("only", "").split(",").filter(Boolean);
const skip = arg("skip", "").split(",").filter(Boolean);
const unknown = [...only, ...skip].filter((n) => !GATES.some((g) => g.name === n));
if (unknown.length) {
  console.log(`unknown gate(s): ${unknown.join(", ")}; known: ${GATES.map((g) => g.name).join(", ")}`);
  process.exit(2);
}
const run = (only.length ? only.map((n) => GATES.find((g) => g.name === n)!) : GATES)
  .filter((g) => !skip.includes(g.name));

/** A Chrome left on our profile (a gate killed mid-run) holds its lock and the next launch fails. */
function killStrays(): void {
  // No leading "--": pkill would read the pattern as an option and kill nothing.
  Bun.spawnSync(["pkill", "-f", `user-data-dir=${profile}`]);
}

interface Row { name: string; rendered: boolean; code: number; ok: number; fail: number; held: number; broken: number; secs: number }

mkdirSync(logDir, { recursive: true });
const rows: Row[] = [];
for (const g of run) {
  if (g.rendered) killStrays();
  console.log(`\n===== ${g.name}: ${g.cmd.join(" ")}`);
  const t0 = Date.now();
  const p = Bun.spawn(g.cmd, { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>, sink: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of s) { const t = dec.decode(chunk); out += t; sink(t); }
  };
  await Promise.all([
    pump(p.stdout, (t) => Bun.write(Bun.stdout, t)),
    pump(p.stderr, (t) => Bun.write(Bun.stderr, t)),
  ]);
  const code = await p.exited;
  writeFileSync(`${logDir}/${g.name}.log`, out);
  const lines = out.split("\n");
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  rows.push({
    name: g.name, rendered: g.rendered, code, secs: (Date.now() - t0) / 1000,
    ok: count(/^ok  /), fail: count(/^FAIL /),
    held: count(/^  ok vacuity:/), broken: count(/^PROBE-FAIL vacuity:/),
  });
}
killStrays();

function verdict(r: Row): string {
  if (r.code === 2) return "INCONCLUSIVE";
  if (r.broken) return "PROBE PASSED";
  if (r.code !== 0 || r.fail) return "FAIL";
  if (r.rendered && r.ok === 0) return "EMPTY";
  return "ok";
}

console.log("\ngate        result         checks ok/fail  probes failed-as-they-must/passed  seconds");
for (const r of rows) {
  const checks = r.ok + r.fail ? `${r.ok}/${r.fail}` : "-";
  const probes = r.held + r.broken ? `${r.held}/${r.broken}` : "-";
  console.log(`${r.name.padEnd(12)}${verdict(r).padEnd(15)}${checks.padEnd(16)}${probes.padEnd(35)}${r.secs.toFixed(0)}`);
}
console.log(`\nlogs in ${logDir}/`);
const bad = rows.filter((r) => verdict(r) !== "ok");
if (bad.length) {
  console.log(`gates: ${bad.length} of ${rows.length} not ok (${bad.map((r) => r.name).join(", ")})`);
  process.exit(1);
}
console.log(`gates: all ${rows.length} ok`);
