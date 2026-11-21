// The opening sweep, checked in the real page: the camera path is continuous
// frame to frame, it lands exactly on the walker's eye and hands over with no
// jump, the landing spot is dry, outside every building and off the
// carriageway, and a skip finishes the move instead of cutting.
//
//   bun tools/verify-intro.ts                      (pompeii, sf, chicago)
//   bun tools/verify-intro.ts --cities pompeii --strip shots/intro
//
// `--strip DIR` also saves a frame every two seconds along the path.
//
// Every bound has a probe: the recorded trace with a 300 m cut spliced in
// must fail the speed bound, and the page's own spot check must refuse a
// carriageway vertex, a building and open water near the spawn. A check that
// stops measuring fails here rather than passing quietly.

import { mkdirSync, writeFileSync } from "node:fs";
import { Cdp } from "./cdp";
import { traceContinuity, INTRO_MAX_SPEED, INTRO_MAX_TURN_DEG_S, INTRO_SKIP_S, type PoseSample } from "../src/sim/intro";

type Sample = PoseSample & { phase: "intro" | "skip" | "walk" };
interface IntroState {
  active: boolean;
  spawn: { x: number; z: number; headingDeg: number; reason: string | null } | null;
  eye: { x: number; y: number; z: number };
  trace: Sample[];
}
type Probe = { x: number; z: number; reason: string | null } | null;

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const cities = (arg("cities", "pompeii,sf,chicago") ?? "").split(",");
const strip = arg("strip");
const port = Number(arg("port", "5193"));
const debugPort = Number(arg("debug-port", "9433"));
const profileDir = arg("profile", "/tmp/flyby-phone-profile")!;

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

try {
  const probe = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
  throw new Error(`port ${port} is already serving (HTTP ${probe.status}); pass --port`);
} catch (err) {
  if (err instanceof Error && err.message.startsWith(`port ${port}`)) throw err;
}
const vite = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdout: "ignore",
  stderr: "ignore",
});
const base = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const cdp = await Cdp.launch({ port: debugPort, width: 411, height: 748, profileDir });
const simTime = (tr: Sample[]) => tr.reduce((s, p) => s + p.dt, 0);

async function load(city: string): Promise<void> {
  await cdp.goto(`${base}/?city=${city}&shot&intro=1`);
  await cdp.waitFor("window.flybyShot && window.flybyShot.intro.trace.length > 0", 240_000, `${city} to load`);
}

try {
  for (const city of cities) {
    await load(city);
    const shots: number[] = [];
    if (strip) mkdirSync(strip, { recursive: true });
    // Ride along, saving a frame every 2 s of sim time.
    for (let k = 0; ; ) {
      const st = await cdp.eval<{ active: boolean; t: number }>(
        "(() => { const i = window.flybyShot.intro; return { active: i.active, t: i.trace.reduce((s, p) => s + p.dt, 0) }; })()",
      );
      if (strip && st.t >= k * 2) {
        const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })) as { data: string };
        writeFileSync(`${strip}/${city}-${String(k).padStart(2, "0")}.jpg`, Buffer.from(shot.data, "base64"));
        shots.push(st.t);
        k++;
      }
      if (!st.active) break;
      await Bun.sleep(50);
    }
    await cdp.waitFor("window.flybyShot.intro.trace.filter((p) => p.phase === 'walk').length >= 30", 30_000, `${city} walk frames`);
    if (strip) {
      const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 })) as { data: string };
      writeFileSync(`${strip}/${city}-landed.jpg`, Buffer.from(shot.data, "base64"));
    }
    const st = await cdp.eval<IntroState>("window.flybyShot.intro");
    const tr = st.trace;
    const run = tr.filter((p) => p.phase === "intro");
    const c = traceContinuity(run);
    check(`${city}: intro ran ~12 s of sim time`, Math.abs(simTime(run) - 12) < 0.3, `${simTime(run).toFixed(2)} s, ${run.length} frames`);
    check(`${city}: max speed <= ${INTRO_MAX_SPEED} m/s`, c.maxSpeed <= INTRO_MAX_SPEED, `${c.maxSpeed.toFixed(0)} m/s`);
    check(`${city}: max turn <= ${INTRO_MAX_TURN_DEG_S} deg/s`, c.maxTurnDegS <= INTRO_MAX_TURN_DEG_S, `${c.maxTurnDegS.toFixed(1)} deg/s`);
    check(`${city}: starts >= 500 m up`, run[0].y - st.eye.y > 500, `${(run[0].y - st.eye.y).toFixed(0)} m above the eye`);
    const last = run[run.length - 1];
    const miss = Math.hypot(last.x - st.eye.x, last.y - st.eye.y, last.z - st.eye.z);
    check(`${city}: lands on the eye`, miss < 0.05, `${miss.toFixed(3)} m`);
    // The hand-over: the walker's first 30 frames continue from the intro's
    // last with no jump in place or angle.
    const hand = traceContinuity([last, ...tr.filter((p) => p.phase === "walk")]);
    check(`${city}: hand-over step < 5 cm`, hand.maxStepM < 0.05, `${hand.maxStepM.toFixed(4)} m`);
    check(`${city}: hand-over turn < 0.5 deg`, hand.maxStepDeg < 0.5, `${hand.maxStepDeg.toFixed(3)} deg`);
    check(`${city}: spawn is standable`, st.spawn !== null && st.spawn.reason === null, JSON.stringify(st.spawn));

    // Probes: the measure must fail a cut, and the spot check must refuse
    // each kind of bad ground.
    const cut = run.map((p, i) => (i > run.length / 2 ? { ...p, x: p.x + 300 } : p));
    const cc = traceContinuity(cut);
    check(`${city}: probe: a 300 m cut FAILS the speed bound`, cc.maxSpeed > INTRO_MAX_SPEED, `${cc.maxSpeed.toFixed(0)} m/s`);
    const probes = await cdp.eval<Record<"carriageway" | "building" | "water", Probe>>("window.flybyShot.spawnProbes()");
    let tested = 0;
    for (const [kind, p] of Object.entries(probes)) {
      if (!p) continue;
      tested++;
      check(`${city}: probe: ${kind} is refused`, p.reason === kind, `got ${p.reason} at ${p.x.toFixed(0)},${p.z.toFixed(0)}`);
    }
    // Pompeii has no open water in reach and no carriageway class roads, so
    // only demand that something was probed.
    check(`${city}: at least one spot probe ran`, tested > 0, `${tested}`);
    if (strip) console.log(`${city}: ${shots.length + 1} frames in ${strip}`);
  }

  // The skip: from the first city, tap at ~3 s; the move must finish within
  // the skip time and still land on the eye, with no single-frame cut.
  {
    const city = cities[0];
    await load(city);
    await cdp.waitFor("window.flybyShot.intro.trace.reduce((s, p) => s + p.dt, 0) > 3", 60_000, "3 s in");
    await cdp.eval("window.flybyShot.skipIntro()");
    await cdp.waitFor("!window.flybyShot.intro.active", 30_000, "skip to finish");
    const st = await cdp.eval<IntroState>("window.flybyShot.intro");
    const sk = st.trace.filter((p) => p.phase === "skip");
    const t = simTime(sk);
    check(`${city}: skip finishes within ${INTRO_SKIP_S} s`, t <= INTRO_SKIP_S + 0.06, `${t.toFixed(2)} s, ${sk.length} frames`);
    const end = sk[sk.length - 1];
    const miss = Math.hypot(end.x - st.eye.x, end.y - st.eye.y, end.z - st.eye.z);
    check(`${city}: skip lands on the eye`, miss < 0.05, `${miss.toFixed(3)} m`);
    const total = st.trace.filter((p) => p.phase !== "walk");
    const c = traceContinuity(total);
    const len = total.reduce((s, p, i) => (i ? s + Math.hypot(p.x - total[i - 1].x, p.y - total[i - 1].y, p.z - total[i - 1].z) : 0), 0);
    check(`${city}: skip has no single-frame cut`, c.maxStepM < len / 5, `${c.maxStepM.toFixed(0)} m max of ${len.toFixed(0)} m`);
  }
} finally {
  cdp.close();
  vite.kill();
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(48)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} intro checks passed`);
if (failed) process.exit(1);
