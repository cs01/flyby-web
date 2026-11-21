// The gate on the shape of a sun shadow's edge: no texel staircase, a
// penumbra of a sensible width, and the shadow reaching as far as its caster
// says it should.
//
// WHY THIS IS NOT IN `bun run check`: it renders, so it needs a GPU, a browser
// and a vite server, like tools/verify-shadow.ts.
//
// WHAT WAS WRONG. The cascades were sampled with 3x3 NEAREST depth compares,
// which can only produce ten grey levels, all of them changing on the shadow
// map's texel grid. Along any edge not aligned with that grid the result was
// a staircase of texel-sized steps with hard corners: 0.2 m on the desktop's
// first cascade in Pompeii, 0.35 m on the phone's. And the normal offset that
// kept the ground from shadowing itself lifted each sample 1.5 + 4.5 * (1 -
// N.L) texels, which under a 25 degree sun ended every shadow on the ground
// 1.3 to 3 m short of its caster. The fix is render/sunshadow.ts
// shadowFilter: hardware PCF (LINEAR compare) over a small rotated disk, each
// tap against the receiver plane's own depth, and a lift of about one texel.
//
// THE SCENE is src/harness/shadowedge.ts: a thin 8 m wall on flat ground
// under a 25 degree sun, Pompeii's cascade splits, the eye 15 m from the
// shadow at eye height so the edge is in the first cascade. The wall's top
// edge runs ANGLES degrees off the light's x axis on the ground. The ground's
// sun visibility is read back from straight above, image x along the edge,
// 5 mm a pixel, 3 m of edge by 8 m across.
//
// THE MEASURES, all on the 50% contour of the shadow, per centimetre of edge
// (the profile averaged over CONTOUR_CM of edge first, so the per-pixel noise
// of the rotated kernel does not read as wobble):
//
//   corners / m   places where the contour's slope changes by more than
//                 CORNER_SLOPE between two CORNER_CM segments, per metre. A
//                 texel staircase is nothing but corners. A filtered edge on
//                 a shallow grid angle still WAVES (the map only knows the
//                 edge to a texel, and no small kernel can average a step
//                 four texels long away), but the wave is round.
//   width         10% to 90% shadow across the edge, on the profile averaged
//                 along the whole edge after aligning each centimetre on its
//                 own edge position, so neither wave nor noise widens it.
//   short         how far the shadow ends short of the wall top's true
//                 shadow line, from the shadow's AREA (a hard edge holding the
//                 same shadow), so a symmetric penumbra does not move it.
//
// Each check is probed in the same binary with the old samplers,
// `?shadowprobe=1` (one nearest compare) and `?shadowprobe=2` (the old 3x3
// nearest, which is exactly the old code, old bias and lift included), and
// the probes named against each check must FAIL it.
//
//   bun tools/verify-shadowedge.ts
//   bun tools/verify-shadowedge.ts --out shots/shadowedge     (also writes the read-backs)
//   bun tools/verify-shadowedge.ts --sweep "tier=full&radius=1.5&angle=12;..."

import { mkdirSync, writeFileSync } from "node:fs";
import { Cdp } from "./cdp";
import { encodePng } from "./pixdiff";

declare const process: { argv: string[]; exit(code?: number): never };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(47)} ${detail}`);
  if (!ok) failures++;
}

/** Edge length the profile is averaged over before the contour is found, cm. */
const CONTOUR_CM = 4;
/** Segment length, cm, and the change of contour slope between two segments, that make a corner. */
const CORNER_CM = 4;
const CORNER_SLOPE = 1.0;

/**
 * Edge angles off the light's x axis. Two, so the staircase has both short
 * and long treads; each puts several periods of it inside the 3 m window.
 * (Under 15 degrees the period outgrows the window and a straight run can
 * read as clean whatever the filter.)
 */
const ANGLES = [30, 60];

// --- THE BOUNDS ------------------------------------------------------------
//
// Measured both ways before they were written down (radius 1 texel, 8 taps
// desktop, 4 phone), and printed beside both on every run:
//
//   tier     measure       new, 30 / 60 deg     probes 1 and 2, 30 / 60 deg
//   full     corners / m   0, 0                 1-6 everywhere, slope 2.0-2.2
//   full     width cm      63, 44               1 cm (one tap), 62-90 (3x3)
//   full     short cm      38, 22               78-135
//   reduced  corners / m   0, 0                 1-3, slope 1.9-2.2
//   reduced  width cm      126, 87              1 cm, 129-185
//   reduced  short cm      68, 43               157-275
//
// The phone's widths are twice the desktop's because its texels are; a 25
// degree sun stretches a texel 2.4x across the ground, so a 1 texel kernel
// is about 0.45 m (desktop) and 0.9 m (phone) of penumbra there.
interface Bounds {
  /** Most corners per metre of edge. */
  corners: number;
  /** 10-90% penumbra width, cm. */
  width: [number, number];
  /** Most the shadow may end short of the true line, cm. */
  short: number;
}

const BOUNDS: Record<"full" | "reduced", Bounds> = {
  full: { corners: 0.34, width: [20, 100], short: 60 },
  reduced: { corners: 0.34, width: [40, 170], short: 110 },
};

interface Edge { w: number; h: number; pxPerM: number; tier: string; probe: number; taps: number; texelWorld: number; data: string }

interface Measure {
  /** Shadowed minus lit at the two ends of the across axis; 1 when the window holds one whole edge. */
  contrast: number;
  corners: number;
  /** The sharpest corner: change of contour slope, cm per cm. */
  sharpest: number;
  /** Rms of the contour about its straight-line fit, cm: the wave, reported only. */
  wave: number;
  width: number;
  short: number;
  texelCm: number;
  taps: number;
}

function lineFitResidual(v: Float64Array): number {
  const n = v.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += v[i]; sxx += i * i; sxy += i * v[i]; }
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const c = (sy - m * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (v[i] - c - m * i) ** 2;
  return Math.sqrt(ss / n);
}

function measure(e: Edge): Measure {
  const raw = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
  const { w, h, pxPerM } = e;
  // Shadow fraction, 0 lit .. 1 shadowed.
  const s = new Float32Array(w * h);
  for (let i = 0; i < s.length; i++) s[i] = 1 - raw[i] / 255;

  // Which end of the across axis is the shadow: the harness puts the lit side
  // at the top, but measure it rather than trust it.
  let topS = 0, botS = 0;
  for (let x = 0; x < w; x++) for (let k = 0; k < 10; k++) { topS += s[k * w + x]; botS += s[(h - 1 - k) * w + x]; }
  const shadowAtBottom = botS > topS;
  const contrast = Math.abs(botS - topS) / (10 * w);
  /** Row k counted from the lit end. */
  const row = (k: number): number => (shadowAtBottom ? k : h - 1 - k);

  const bin = Math.round(pxPerM / 100);
  const nb = Math.floor(w / bin);
  const metres = (nb * bin) / pxPerM;

  // Hard-edge equivalent position per centimetre, rows from the lit end.
  const area = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let sum = 0;
    for (let x = b * bin; x < (b + 1) * bin; x++) for (let y = 0; y < h; y++) sum += s[y * w + x];
    area[b] = h - sum / bin;
  }

  // The 50% contour, cm from the lit end.
  const sm = Math.round((CONTOUR_CM / 2 / 100) * pxPerM);
  const con = new Float64Array(nb).fill(NaN);
  for (let b = 0; b < nb; b++) {
    const mid = b * bin + (bin >> 1);
    const x0 = Math.max(0, mid - sm), x1 = Math.min(w, mid + sm + 1);
    let prev = 0;
    for (let k = 0; k < h; k++) {
      let v = 0;
      for (let x = x0; x < x1; x++) v += s[row(k) * w + x];
      v /= x1 - x0;
      if (k > 0 && prev < 0.5 && v >= 0.5) {
        con[b] = ((k - 1 + (0.5 - prev) / (v - prev)) / pxPerM) * 100;
        break;
      }
      prev = v;
    }
  }

  let corners = 0, sharpest = 0, inCorner = false;
  for (let b = CORNER_CM; b + CORNER_CM < nb; b++) {
    const k = Math.abs(con[b + CORNER_CM] - 2 * con[b] + con[b - CORNER_CM]) / CORNER_CM;
    // NaN (no crossing found) counts as the sharpest possible corner.
    const sharp = !(k <= CORNER_SLOPE);
    sharpest = Math.max(sharpest, Number.isNaN(k) ? Infinity : k);
    if (sharp && !inCorner) corners++;
    inCorner = sharp;
  }

  // The window is centred on the wall top's centre line; the shadow's true
  // edge is 10 cm (half the wall) further toward the lit end.
  const trueRow = h / 2 - 0.1 * pxPerM;
  let meanArea = 0;
  for (const a of area) meanArea += a;
  meanArea /= nb;
  const short = ((meanArea - trueRow) / pxPerM) * 100;

  // Width, on the profile aligned per centimetre on its own edge and averaged.
  const half = Math.round(1.5 * pxPerM);
  const prof = new Float64Array(2 * half + 1);
  const cnt = new Float64Array(2 * half + 1);
  for (let b = 0; b < nb; b++) {
    for (let x = b * bin; x < (b + 1) * bin; x++) {
      for (let k = 0; k < h; k++) {
        const d = Math.round(k - area[b]);
        if (d < -half || d > half) continue;
        prof[d + half] += s[row(k) * w + x];
        cnt[d + half]++;
      }
    }
  }
  for (let i = 0; i < prof.length; i++) prof[i] = cnt[i] ? prof[i] / cnt[i] : NaN;
  const cross = (t: number): number => {
    for (let i = 1; i < prof.length; i++) {
      if (prof[i - 1] < t && prof[i] >= t) return i - 1 + (t - prof[i - 1]) / (prof[i] - prof[i - 1]);
    }
    return NaN;
  };
  const width = ((cross(0.9) - cross(0.1)) / pxPerM) * 100;

  return {
    contrast, corners: corners / metres, sharpest, wave: lineFitResidual(con), width, short,
    texelCm: e.texelWorld * 100, taps: e.taps,
  };
}

const fmt = (m: Measure): string =>
  `corners ${m.corners.toFixed(2)}/m (sharpest ${m.sharpest.toFixed(2)})  width ${m.width.toFixed(1)} cm  ` +
  `short ${m.short.toFixed(1)} cm  wave ${m.wave.toFixed(1)} cm rms  [texel ${m.texelCm.toFixed(1)} cm, ${m.taps} taps]`;

async function main(): Promise<void> {
  const port = Number(arg("port", "5213"));
  const dbg = Number(arg("debug-port", "9583"));
  const profile = arg("profile", "/tmp/flyby-shots-profile");
  const out = arg("out", "");
  if (out) mkdirSync(out, { recursive: true });

  // Refuse a port something else serves: that would measure another build.
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`port ${port} is already serving; use --port with a free one`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`port ${port} is already`)) throw err;
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
    } catch {
      // Still starting.
    }
    await Bun.sleep(100);
  }
  const cdp = await Cdp.launch({ port: dbg, width: 256, height: 256, profileDir: profile });

  const run = async (query: string): Promise<Measure> => {
    await cdp.goto(`${base}/tools/shadowedge.html?${query}`);
    await cdp.waitFor("window.__edge", 30000, `shadow edge ${query}`);
    const e = await cdp.eval<Edge>("window.__edge");
    if (out) {
      const raw = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
      const rgba = new Uint8Array(e.w * e.h * 4);
      for (let i = 0; i < raw.length; i++) rgba.set([raw[i], raw[i], raw[i], 255], i * 4);
      writeFileSync(`${out}/${query.replace(/[=&]/g, "_")}.png`, encodePng({ w: e.w, h: e.h, data: rgba }));
    }
    return measure(e);
  };

  try {
    const sweep = arg("sweep", "");
    if (sweep) {
      for (const q of sweep.split(";")) console.log(`${q.padEnd(40)} ${fmt(await run(q))}`);
    } else {
      for (const tier of ["full", "reduced"] as const) {
        const b = BOUNDS[tier];
        for (const angle of ANGLES) {
          const at = `${tier}, ${angle} deg`;
          const real = await run(`tier=${tier}&angle=${angle}`);
          const p1 = await run(`tier=${tier}&angle=${angle}&shadowprobe=1`);
          const p2 = await run(`tier=${tier}&angle=${angle}&shadowprobe=2`);
          console.log(`${at}: ${fmt(real)}`);

          // Without this every other check could pass on an empty frame.
          const whole = (m: Measure): boolean => m.contrast > 0.95;
          check(`${at}: the window holds one whole edge`, whole(real) && whole(p1) && whole(p2),
            `contrast ${real.contrast.toFixed(3)}, probes ${p1.contrast.toFixed(3)} ${p2.contrast.toFixed(3)}`);

          const stair = (m: Measure): boolean => m.corners <= b.corners;
          check(`${at}: no staircase corners`, stair(real), `${real.corners.toFixed(2)}/m <= ${b.corners}, sharpest ${real.sharpest.toFixed(2)}`);
          probe(`${at}: corners, one nearest tap`, stair(p1), `${p1.corners.toFixed(2)}/m, sharpest ${p1.sharpest.toFixed(2)}`);
          probe(`${at}: corners, old 3x3`, stair(p2), `${p2.corners.toFixed(2)}/m, sharpest ${p2.sharpest.toFixed(2)}`);

          const wide = (m: Measure): boolean => m.width >= b.width[0] && m.width <= b.width[1];
          check(`${at}: penumbra width`, wide(real), `${real.width.toFixed(1)} cm in [${b.width[0]}, ${b.width[1]}]`);
          probe(`${at}: width, one nearest tap`, wide(p1), `${p1.width.toFixed(1)} cm`);

          const reach = (m: Measure): boolean => m.short <= b.short;
          check(`${at}: shadow reaches its caster's line`, reach(real), `short by ${real.short.toFixed(1)} cm <= ${b.short}`);
          probe(`${at}: reach, old 3x3 and lift`, reach(p2), `short by ${p2.short.toFixed(1)} cm`);
        }
      }
    }
  } finally {
    cdp.close();
    vite.kill();
  }

  for (const p of cdp.problems) console.log(`page: ${p}`);
  if (cdp.problems.length) check("page logged no errors", false, `${cdp.problems.length} problem(s)`);
  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
