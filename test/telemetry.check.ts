// Gate on src/app/telemetry.ts: percentile math, and that the beacon stays
// silent in shot mode, on localhost and with ?notelemetry (a test run that
// reported itself would pollute the perf log with the harness's numbers).

import { Telemetry, percentile } from "../src/app/telemetry";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(60)} ${detail}`);
  if (!ok) failures++;
}

const ramp = Float64Array.from({ length: 100 }, (_, i) => i + 1);
check("p50 of 1..100", percentile(ramp, 100, 0.5) === 51, `${percentile(ramp, 100, 0.5)}`);
check("p95 of 1..100", percentile(ramp, 100, 0.95) === 96, `${percentile(ramp, 100, 0.95)}`);
check("empty window is 0, not NaN", percentile(ramp, 0, 0.5) === 0, "");

function sends(search: string, hostname: string): number {
  let fetched = 0;
  const g = globalThis as any;
  g.location = { search, hostname };
  g.document = { hidden: false };
  g.innerWidth = 412; g.innerHeight = 860; g.devicePixelRatio = 2.6;
  g.matchMedia = () => ({ matches: true });
  g.fetch = () => { fetched++; return Promise.resolve(); };
  const gl = { getExtension: () => null, getParameter: () => "" } as any;
  const t = new Telemetry(gl, () => ({ city: "sf", tier: "reduced", level: 0, scale: 1 }));
  for (let i = 0; i < 100 * 30; i++) t.frame(33, 1 / 30);
  return fetched;
}
check("live page sends two samples", sends("", "chadsmith.dev") === 2, `${sends("", "chadsmith.dev")}`);
check("probe: shot mode sends none", sends("?shot", "chadsmith.dev") === 0, "");
check("probe: localhost sends none", sends("", "localhost") === 0, "");
check("probe: ?notelemetry sends none", sends("?notelemetry", "chadsmith.dev") === 0, "");

if (failures) process.exit(1);
