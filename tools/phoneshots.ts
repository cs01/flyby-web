// Phone-emulated screenshots of the live UI, overlays included.
//
// tools/shots.ts photographs the canvas in `?shot` mode, where #ui is hidden,
// so it cannot see the thing that goes wrong on a phone: panels piled on top
// of each other. This runs the real page under Chrome's device emulation
// (mobile viewport, device pixel ratio, touch, so `pointer: coarse` matches)
// and captures the composited page.
//
//   bun tools/phoneshots.ts --out shots/phone-after
//   bun tools/phoneshots.ts --out shots/phone-after --only pompeii-walk-411
//
// Each scene also reports the overlap audit from window.flybyUi.overlaps(), so
// a pile-up shows as a number and not only as a picture.

import { mkdirSync, writeFileSync } from "node:fs";
import { Cdp } from "./cdp";

interface Scene {
  name: string;
  query: string;
  w: number;
  h: number;
  dpr: number;
  /** JS run once the app is up, before the capture (taps, opening sheets). */
  act?: string;
  /** Extra settle time after `act`, ms. */
  settleMs?: number;
  /** A mouse-and-keyboard window instead of a phone: no touch, no audit. */
  desktop?: boolean;
  /** Capture this many ms after load instead of waiting for frames (the
   *  intro, which is over in 12 s). */
  atMs?: number;
}

const tap = (label: string) =>
  `[...document.querySelectorAll('.modebar button')].find((b) => /${label}/i.test(b.textContent ?? ''))?.click()`;

const SIZES = [
  { tag: "360", w: 360, h: 640, dpr: 3 },
  { tag: "411", w: 411, h: 748, dpr: 2.63 },
  { tag: "land", w: 748, h: 411, dpr: 2.63 },
];

// `intro=0` everywhere except where the intro itself is the subject: the
// sweep is ten seconds of camera move and the controls fade in after it.
const BASE: { name: string; query: string; act?: string; settleMs?: number; atMs?: number }[] = [
  { name: "pompeii-walk", query: "city=pompeii&intro=0", act: tap("walk"), settleMs: 2500 },
  { name: "sf-plane", query: "city=sf&intro=0&start=plane" },
  { name: "sf-walk-mission", query: "city=sf&intro=0", act: "document.querySelector('.mission-btn')?.click()", settleMs: 2500 },
  { name: "pompeii-menu", query: "city=pompeii&intro=0", act: "document.querySelector('.topbar-menu')?.click()", settleMs: 600 },
  { name: "pompeii-time", query: "city=pompeii&intro=0", act: "document.querySelector('.topbar-time')?.click()", settleMs: 600 },
  { name: "pompeii-cart", query: "city=pompeii&intro=0", act: tap("cart"), settleMs: 2500 },
  { name: "pompeii-drone", query: "city=pompeii&intro=0", act: tap("drone"), settleMs: 2500 },
  { name: "pompeii-intro", query: "city=pompeii", atMs: 5000 },
];

const SCENES: Scene[] = [
  ...BASE.flatMap((b) => SIZES.map((s) => ({ ...b, name: `${b.name}-${s.tag}`, w: s.w, h: s.h, dpr: s.dpr }))),
  { name: "desktop-pompeii-walk", query: "city=pompeii&intro=0", w: 1280, h: 720, dpr: 1, desktop: true, settleMs: 2500 },
  { name: "desktop-sf-plane", query: "city=sf&intro=0&start=plane", w: 1280, h: 720, dpr: 1, desktop: true },
];
const failures: string[] = [];
let probed = false;

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const outDir = arg("out", "shots/phone")!;
const only = arg("only");
const port = Number(arg("port", "5191"));
const debugPort = Number(arg("debug-port", "9431"));
const profileDir = arg("profile", "/tmp/flyby-phone-profile")!;
const extra = arg("query", "");

mkdirSync(outDir, { recursive: true });
const scenes = only ? SCENES.filter((s) => only.split(",").some((o) => s.name.startsWith(o))) : SCENES;
if (!scenes.length) throw new Error(`no scene matches --only ${only}`);

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

const cdp = await Cdp.launch({ port: debugPort, width: 800, height: 800, profileDir });
const report: Record<string, unknown> = {};
try {
  for (const s of scenes) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: s.dpr, mobile: !s.desktop });
    await cdp.send("Emulation.setTouchEmulationEnabled", s.desktop ? { enabled: false } : { enabled: true, maxTouchPoints: 5 });
    cdp.problems.length = 0;
    // Marked so the waits below cannot be satisfied by the PREVIOUS scene's
    // page before the navigation has replaced it.
    await cdp.eval("window.__stale = 1").catch(() => {});
    // `safe=0`: this harness closes every page inside safe mode's 20 s settle
    // window, which app/safemode.ts counts as a crash, and three of those
    // walked the stored rung to 3, where the whole canvas renders black.
    await cdp.goto(`${base}/?${s.query}&safe=0${extra ? `&${extra}` : ""}`);
    // A stalled load (a tile server that never answers) fails this scene,
    // loudly, and the run goes on to the next.
    try {
      await cdp.waitFor("!window.__stale && window.flybyShot", 120_000, `${s.name} to load`);
      if (s.atMs) {
        await cdp.waitFor("window.flybyShot.frames > 1", 60_000, `${s.name} first frame`);
        await Bun.sleep(s.atMs);
      } else {
        await cdp.waitFor("window.flybyShot.frames > 90", 60_000, `${s.name} to settle`);
      }
    } catch (e) {
      failures.push(`${s.name}: ${(e as Error).message}`);
      console.log(`SKIP ${s.name}: ${(e as Error).message}`);
      continue;
    }
    if (s.act) {
      await cdp.eval(s.act);
      await Bun.sleep(s.settleMs ?? 500);
    } else if (!s.atMs) await Bun.sleep(s.settleMs ?? 800);
    const coarse = await cdp.eval<boolean>("matchMedia('(pointer: coarse)').matches");
    // A lost WebGL context draws a black canvas under a perfectly good DOM;
    // a layout shot of that would pass the audit and show nothing.
    const lost = await cdp.eval<boolean>("!!document.getElementById('view').getContext('webgl2')?.isContextLost()");
    if (lost) failures.push(`${s.name}: WebGL context lost, the picture is black`);
    const audit = await cdp.eval<string[] | null>("window.flybyUi?.overlaps?.() ?? null");
    // The audit's own probe, once: a control dropped on top of the bar must
    // be reported, or the audit has stopped looking.
    if (!s.desktop && !probed && audit) {
      probed = true;
      const caught = await cdp.eval<number>(`(() => {
        const d = document.createElement('button');
        d.className = 'touch-btn';
        d.textContent = 'probe';
        d.style.cssText = 'position:absolute;left:20px;top:20px;width:80px;height:80px;display:block';
        document.getElementById('ui').append(d);
        const n = window.flybyUi.overlaps().filter((s) => s.includes('probe')).length;
        d.remove();
        return n;
      })()`);
      if (caught === 0) failures.push(`${s.name}: probe: an injected overlap was NOT reported`);
      else console.log(`probe: injected overlap reported (${caught})`);
    }
    const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 85 })) as { data: string };
    const file = `${outDir}/${s.name}.jpg`;
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    report[s.name] = { coarse, audit, problems: cdp.problems.slice(0, 5) };
    console.log(`${file.padEnd(48)} coarse=${coarse} overlaps=${JSON.stringify(audit)}`);
    if (s.desktop) {
      if (coarse || audit !== null) failures.push(`${s.name}: desktop got the phone layout`);
    } else {
      // No audit means no phone shell, which would make every "no overlaps"
      // above vacuous.
      if (!coarse || audit === null) failures.push(`${s.name}: no phone layout (coarse=${coarse})`);
      else for (const a of audit) failures.push(`${s.name}: ${a}`);
    }
  }
} finally {
  cdp.close();
  vite.kill();
}
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
for (const f of failures) console.log(`FAIL  ${f}`);
console.log(`\n${scenes.length} scenes, ${failures.length} layout failures`);
if (failures.length) process.exit(1);
