// The gate on the city's shadows from altitude: do they end where the
// cascades end.
//
// WHY THIS IS NOT IN `bun run check`: the same reason as tools/verify-water.ts.
// It measures rendered frames, which needs a GPU, a browser and a vite server.
//
// WHAT WAS WRONG. The sun cascades in render/sunshadow.ts are fitted to the
// view, so they end at a fixed distance from the camera: 1.4 km on the reduced
// tier, 6 km on the full one, the last 15% fading to unshadowed. From altitude
// that read as a disc of shadowed city travelling with the aircraft over an
// unshadowed one. The fix is a static map over the whole baked city, which
// takes over from the last cascade instead of the fade.
//
// THE CLAIMS, per tier, each on a pose whose ground spans that tier's last
// cascade edge (`?tier=reduced` forces the phone plan on this machine):
//
//   reduced  manhattan-high-shadow    900 m up, edge at 1.4 km
//   full     manhattan-higher-shadow  3.5 km up, edge at 6 km
//
//   BEYOND THE CASCADES THE CITY IS STILL SHADOWED. The shadowed share of the
//   visible ground in an annulus wholly past the last cascade has a floor:
//   2 to 5 km on the reduced tier, 6.5 to 9.5 km on the full one (whose 6 km
//   cascade already covers 2 to 5 km).
//
//   AND THERE IS NO EDGE. Raw shares in two neighbouring rings cannot answer
//   that, because the city itself changes between them: from 900 m up the
//   share drops from 0.98 at 1.0 km to 0.30 at 1.4 km under the full tier's
//   city map ALONE,
//   with no edge anywhere, because the streets stop being visible between the
//   towers. So each ring's share is divided by the same ring's share in a
//   REFERENCE frame, `?cityshadowonly=1`, which samples the city map at every
//   distance and so has no handover in it at all. Just inside the handoff
//   (0.70 to 0.85 of the last cascade's far) that ratio says how well the
//   cascades agree with the map; just outside (1.00 to 1.15) the frame IS the
//   map. Their difference has a ceiling.
//
// Each claim is probed with `?nocityshadow=1`, the same binary with the city
// map never handed its casters, which is the renderer before it existed.
//
// WHICH PIXELS ARE SHADOWED GROUND is not guessed from colour: every frame is
// rendered under `?groundDebug=1`, where the terrain, road and pavement
// shaders paint their own sun visibility RED (shadowed) or BLUE (lit), water
// excluded. Buildings stand in that frame as normal, so they hide exactly the
// ground they hide in the beauty frame.
//
// WHERE A PIXEL IS comes from the camera the page drew it with (shots.ts saves
// it beside the frame), unprojected onto a level plane at GROUND_Y. Manhattan
// in view lies between 0 and 30 m, so the plane is out by at most 20 m, which
// moves a pixel's distance by under 2.5% of itself, against rings 15% wide.
// The probe frames agree: their shadows stop inside the fade, at 1,320 m and
// 5,560 m against cascade fars of 1,400 and 6,000.
//
//   bun run shadow
//   bun tools/verify-shadow.ts --out shots/shadow --keep
//   bun tools/verify-shadow.ts --out shots/shadow --reuse   (measure only)

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { decodePng } from "./pixdiff";

declare const process: { argv: string[]; exit(code?: number): never };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

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

/** Height of the plane pixels are unprojected onto, metres; see the header. */
const GROUND_Y = 10;

// --- THE BOUNDS ------------------------------------------------------------
//
// Literals, measured both ways before they were written down, and printed
// beside both measurements on every run:
//
//   tier     measure                          city map   probe    bound
//   reduced  shadowed share, 2 to 5 km        0.252      0.000    >= 0.12
//   reduced  ratio step at 1.4 km             0.135      0.865    <= 0.35
//   full     shadowed share, 6.5 to 9.5 km    0.146      0.000    >= 0.07
//   full     ratio step at 6 km               0.030      0.421    <= 0.11
//
// The floors are half the measured share: the probe's zero cannot get closer.
// The ceilings are near the geometric middle of their pairs. The reduced step
// is not zero because the phone's last cascade is a 1024 map with the
// cascades' normal offset, and finds 0.87 of the shadow the city map does just
// inside 1.4 km; the full tier's cascade 2 is folded together with the map
// (bandVisibility in render/sunshadow.ts) and agrees with it to 3%.
interface TierGate {
  tier: "full" | "reduced";
  pose: string;
  /** The last cascade's far distance on this tier, metres; CASCADE_FAR in render/sunshadow.ts. */
  far: number;
  annulus: [number, number];
  floor: number;
  step: number;
}

const GATES: TierGate[] = [
  { tier: "reduced", pose: "manhattan-high-shadow", far: 1400, annulus: [2000, 5000], floor: 0.12, step: 0.35 },
  { tier: "full", pose: "manhattan-higher-shadow", far: 6000, annulus: [6500, 9500], floor: 0.07, step: 0.11 },
];

/** Run the screenshot harness once, for one query variant. */
async function shoot(
  outDir: string, pose: string, query: string, port: number, dbg: number, profile: string,
): Promise<void> {
  const p = Bun.spawn(
    [
      "bun", "tools/shots.ts", "--only", pose, "--out", outDir,
      "--port", String(port), "--debug-port", String(dbg), "--profile", profile, "--query", query,
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" },
  );
  const code = await p.exited;
  if (code !== 0) throw new Error(`shots.ts exited ${code} for query "${query}"`);
}

interface View { pos: number[]; world: number[]; projInv: number[] }

/** Column-major 4x4 times (x, y, z, 1), perspective-divided. */
function xform(m: number[], x: number, y: number, z: number): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

interface Frame { cls: Uint8Array; dist: Float32Array }

/**
 * Per pixel: 1 shadowed ground, 2 lit ground, 0 anything else; and the view
 * distance at which the pixel's ray meets the ground plane (Infinity above the
 * horizon). View distance, not distance along the ground, because that is
 * what the cascades are cut by.
 */
function measureFrame(dir: string, pose: string): Frame {
  const img = decodePng(`${dir}/${pose}.png`);
  const meta = JSON.parse(readFileSync(`${dir}/shots.json`, "utf8")) as { name: string; view: View | null }[];
  const view = meta.find((m) => m.name === pose)?.view;
  if (!view) throw new Error(`${dir}/shots.json has no camera for ${pose}`);

  const { w, h } = img;
  const cls = new Uint8Array(w * h);
  const dist = new Float32Array(w * h);
  const [cx, cy, cz] = view.pos;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // The debug colours come out of the tone curve near (181, 0, 0) and
      // (0, 0, 181); nothing else in the frame is that saturated.
      const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
      if (r > 120 && g < 40 && b < 40) cls[i] = 1;
      else if (b > 120 && r < 40 && g < 40) cls[i] = 2;

      const v = xform(view.projInv, ((x + 0.5) / w) * 2 - 1, 1 - ((y + 0.5) / h) * 2, 0.5);
      const p = xform(view.world, v[0], v[1], v[2]);
      const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
      dist[i] = dy >= 0 ? Infinity : ((GROUND_Y - cy) / dy) * Math.hypot(dx, dy, dz);
    }
  }
  return { cls, dist };
}

/** Shadowed share of the ground pixels whose distance is in [lo, hi), and how many there were. */
function share(f: Frame, [lo, hi]: [number, number]): { frac: number; n: number } {
  let s = 0, n = 0;
  for (let i = 0; i < f.cls.length; i++) {
    if (!f.cls[i] || f.dist[i] < lo || f.dist[i] >= hi) continue;
    n++;
    if (f.cls[i] === 1) s++;
  }
  return { frac: n ? s / n : 0, n };
}

/** The farthest distance at which any ground pixel is shadowed, to the nearest 20 m. */
function shadowReach(f: Frame): number {
  let reach = 0;
  for (let i = 0; i < f.cls.length; i++) if (f.cls[i] === 1 && f.dist[i] < 1e5) reach = Math.max(reach, f.dist[i]);
  return Math.round(reach / 20) * 20;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots/shadow");
  const port = Number(arg("port", "5177"));
  const dbg = Number(arg("debug-port", "9411"));
  const profile = arg("profile", "/tmp/flyby-shots-profile");
  mkdirSync(outDir, { recursive: true });

  const VARIANTS = { city: "", probe: "&nocityshadow=1", ref: "&cityshadowonly=1" } as const;
  const dirOf = (g: TierGate, v: keyof typeof VARIANTS): string => `${outDir}/${g.tier}-${v}`;

  if (!has("reuse")) {
    for (const g of GATES) {
      for (const v of Object.keys(VARIANTS) as (keyof typeof VARIANTS)[]) {
        console.log(`rendering ${g.pose}, ${g.tier} tier, ${v} ...`);
        await shoot(dirOf(g, v), g.pose, `tier=${g.tier}&groundDebug=1${VARIANTS[v]}`, port, dbg, profile);
      }
    }
    console.log("");
  }

  const km = (r: [number, number]): string => `${(r[0] / 1000).toFixed(2)}-${(r[1] / 1000).toFixed(2)} km`;

  for (const g of GATES) {
    const city = measureFrame(dirOf(g, "city"), g.pose);
    const none = measureFrame(dirOf(g, "probe"), g.pose);
    const ref = measureFrame(dirOf(g, "ref"), g.pose);
    const inside: [number, number] = [g.far * 0.70, g.far * 0.85];
    const outside: [number, number] = [g.far, g.far * 1.15];

    // The whole curve, so a step that moved somewhere the rings do not look
    // is still visible in the output.
    const bins = [0.5, 0.7, 0.85, 1.0, 1.15, 1.5, 2, 3, 4, 6].map((k) => k * g.far);
    const curve = (f: Frame): string =>
      bins.slice(0, -1).map((lo, k) => share(f, [lo, bins[k + 1]]).frac.toFixed(2).padStart(5)).join(" ");
    console.log(`${g.tier} on ${g.pose}: shadows reach ${shadowReach(city)} m, probe ${shadowReach(none)} m`);
    console.log(`  distance / far   ${bins.slice(0, -1).map((b) => (b / g.far).toFixed(2).padStart(5)).join(" ")}`);
    console.log(`  city map         ${curve(city)}`);
    console.log(`  ?nocityshadow    ${curve(none)}`);
    console.log(`  ?cityshadowonly  ${curve(ref)}`);

    const aC = share(city, g.annulus);
    const aN = share(none, g.annulus);
    const rIn = share(ref, inside);
    const rOut = share(ref, outside);
    const ratio = (f: Frame): [number, number] => [share(f, inside).frac / rIn.frac, share(f, outside).frac / rOut.frac];
    const [cIn, cOut] = ratio(city);
    const [nIn, nOut] = ratio(none);
    const stepC = Math.abs(cIn - cOut);
    const stepN = Math.abs(nIn - nOut);

    const minN = Math.min(aC.n, rIn.n, rOut.n);
    const minRef = Math.min(rIn.frac, rOut.frac);
    check(
      `${g.tier}: enough ground, and shadow, in every ring`,
      minN >= 3000 && minRef >= 0.05,
      `${minN} px, reference share >= ${minRef.toFixed(3)}`,
    );

    check(`${g.tier}: shadowed past the cascades, ${km(g.annulus)}`, aC.frac >= g.floor, `${aC.frac.toFixed(3)} >= ${g.floor}`);
    probe(`${g.tier}: annulus, ?nocityshadow`, aN.frac >= g.floor, `${aN.frac.toFixed(3)} >= ${g.floor}`);

    check(
      `${g.tier}: no edge at the last cascade (${g.far} m)`,
      stepC <= g.step,
      `|${cIn.toFixed(3)} - ${cOut.toFixed(3)}| = ${stepC.toFixed(3)} <= ${g.step}`,
    );
    probe(
      `${g.tier}: edge, ?nocityshadow`,
      stepN <= g.step,
      `|${nIn.toFixed(3)} - ${nOut.toFixed(3)}| = ${stepN.toFixed(3)} <= ${g.step}`,
    );
  }

  if (!has("keep")) rmSync(outDir, { recursive: true, force: true });

  console.log(`\n${checks} checks, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await main();
