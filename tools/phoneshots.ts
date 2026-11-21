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
}

const SIZES = [
  { tag: "360", w: 360, h: 640, dpr: 3 },
  { tag: "411", w: 411, h: 748, dpr: 2.63 },
  { tag: "land", w: 748, h: 411, dpr: 2.63 },
];

// `intro=0` everywhere except where the intro itself is the subject: the
// sweep is ten seconds of camera move and the controls fade in after it.
const BASE: { name: string; query: string; act?: string; settleMs?: number }[] = [
  { name: "pompeii-walk", query: "city=pompeii&intro=0", act: "[...document.querySelectorAll('.modebar button')].find((b) => /walk/i.test(b.textContent ?? ''))?.click()", settleMs: 2500 },
  { name: "sf-plane", query: "city=sf&intro=0&start=plane" },
  { name: "sf-walk-mission", query: "city=sf&intro=0", act: "document.querySelector('.mission-btn')?.click()", settleMs: 2500 },
  { name: "pompeii-menu", query: "city=pompeii&intro=0", act: "document.querySelector('.topbar-menu')?.click()", settleMs: 600 },
  { name: "pompeii-time", query: "city=pompeii&intro=0", act: "document.querySelector('.topbar-time')?.click()", settleMs: 600 },
];

const SCENES: Scene[] = BASE.flatMap((b) => SIZES.map((s) => ({ ...b, name: `${b.name}-${s.tag}`, w: s.w, h: s.h, dpr: s.dpr })));

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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: s.dpr, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    cdp.problems.length = 0;
    await cdp.goto(`${base}/?${s.query}${extra ? `&${extra}` : ""}`);
    await cdp.waitFor("window.flybyShot", 240_000, `${s.name} to load`);
    await cdp.waitFor("window.flybyShot.frames > 90", 60_000, `${s.name} to settle`);
    if (s.act) {
      await cdp.eval(s.act);
      await Bun.sleep(s.settleMs ?? 500);
    } else await Bun.sleep(800);
    const coarse = await cdp.eval<boolean>("matchMedia('(pointer: coarse)').matches");
    const audit = await cdp.eval<unknown>("window.flybyUi?.overlaps?.() ?? null");
    const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
    const file = `${outDir}/${s.name}.png`;
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    report[s.name] = { coarse, audit, problems: cdp.problems.slice(0, 5) };
    console.log(`${file.padEnd(48)} coarse=${coarse} overlaps=${JSON.stringify(audit)}`);
  }
} finally {
  cdp.close();
  vite.kill();
}
writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
