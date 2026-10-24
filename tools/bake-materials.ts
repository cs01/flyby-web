// Bakes the CC0 wall and roof scans in src/render/materials.ts into the three
// texture-array strips the building shader samples, plus a manifest of what was
// measured on them.
//
//   bun tools/bake-materials.ts            (downloads into the shared bake cache)
//
// Output, per resolution (512 full tier, 256 reduced):
//   public/materials/albedo-<res>.jpg   sRGB colour, layers stacked vertically
//   public/materials/normal-<res>.jpg   tangent-space normal, OpenGL convention
//   public/materials/rh-<res>.jpg       R roughness, G height, B ambient occlusion
//   public/materials/manifest.json      per-layer linear mean, tile size, lattice
//
// Why strips of JPEG and not KTX2: the browser decodes a JPEG in a worker for
// free and three can upload RGBA8 to a 2D array on every WebGL2 device. A basis
// transcoder is another 200 kB of wasm to save about a megabyte, and the
// reduced tier is already under two.
//
// ffmpeg does the resampling (area filter, so a 1024 px scan averages into 512
// rather than aliasing) and the encoding. Everything that is a MEASUREMENT
// (the means, the lattice periods) is done here in TS on the raw pixels, so it
// can be read and argued with.

import { mkdirSync, existsSync, writeFileSync, statSync, readdirSync } from "node:fs";
import {
  MATERIALS,
  MAT_RES_FULL,
  MAT_RES_REDUCED,
  type MaterialManifest,
} from "../src/render/materials";

declare const process: { env: Record<string, string | undefined>; exit(code?: number): never };

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const OUT = `${ROOT}public/materials`;
// The shared bake cache, the same one bake-city.ts uses: a worktree removed
// after merging must not take the downloads with it.
const CACHE = `${process.env["FLYBY_CACHE"] ?? `${process.env["HOME"]}/.cache/flyby-web-bake`}/materials`;

async function run(cmd: string[], input?: Uint8Array): Promise<Uint8Array> {
  const p = Bun.spawn(cmd, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (input) {
    p.stdin!.write(input);
    p.stdin!.end();
  }
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const code = await p.exited;
  if (code !== 0) {
    const err = await new Response(p.stderr).text();
    throw new Error(`${cmd[0]} exited ${code}: ${err.slice(0, 400)}`);
  }
  return out;
}

/** The extracted scan directory for one asset, downloading it the first time. */
async function source(acg: string): Promise<string> {
  const dir = `${CACHE}/${acg}`;
  if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith("_Color.jpg"))) return dir;
  mkdirSync(dir, { recursive: true });
  const url = `https://ambientcg.com/get?file=${acg}_1K-JPG.zip`;
  console.log(`  fetching ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "flyby-web bake-materials" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const zip = `${dir}/${acg}.zip`;
  await Bun.write(zip, new Uint8Array(await res.arrayBuffer()));
  await run(["unzip", "-o", "-q", zip, "-d", dir]);
  return dir;
}

function mapPath(dir: string, acg: string, map: string): string | null {
  const p = `${dir}/${acg}_1K-JPG_${map}.jpg`;
  return existsSync(p) ? p : null;
}

/** One map, resampled to res x res, as packed rgb24. */
async function load(path: string, res: number): Promise<Uint8Array> {
  return run([
    "ffmpeg", "-loglevel", "error", "-i", path,
    "-vf", `scale=${res}:${res}:flags=area`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
}

async function sourceSize(path: string): Promise<[number, number]> {
  const out = new TextDecoder().decode(await run([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", path,
  ]));
  const [w, h] = out.trim().split(",").map(Number);
  return [w, h];
}

const toLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/**
 * How many times a lattice repeats across the tile along one axis, from the
 * circular autocorrelation of the height map. The scans tile, so the wrap is
 * honest. Returns 0 when no lag past the first zero crossing correlates above
 * 0.25, which is what a material without a lattice does.
 */
function latticeRepeats(h: Float32Array, res: number, axis: "x" | "y"): { repeats: number; peak: number } {
  let mean = 0;
  for (const v of h) mean += v;
  mean /= h.length;
  let varSum = 0;
  for (const v of h) varSum += (v - mean) * (v - mean);
  if (varSum <= 0) return { repeats: 0, peak: 0 };
  const corr = new Float32Array(res / 2 + 1);
  for (let lag = 1; lag <= res / 2; lag++) {
    let s = 0;
    for (let y = 0; y < res; y++) {
      for (let x = 0; x < res; x++) {
        const a = h[y * res + x] - mean;
        const b = axis === "x"
          ? h[y * res + ((x + lag) % res)] - mean
          : h[((y + lag) % res) * res + x] - mean;
        s += a * b;
      }
    }
    corr[lag] = s / varSum;
  }
  let lag = 1;
  while (lag <= res / 2 && corr[lag] > 0) lag++;
  let best = 0, bestLag = 0;
  for (; lag <= res / 2; lag++) {
    if (corr[lag] > best && corr[lag] >= corr[lag - 1] && (lag === res / 2 || corr[lag] >= corr[lag + 1])) {
      best = corr[lag];
      bestLag = lag;
      // The FIRST strong peak is the module; later ones are its multiples.
      if (best > 0.25) break;
    }
  }
  if (best < 0.25 || bestLag === 0) return { repeats: 0, peak: best };
  return { repeats: Math.round(res / bestLag), peak: best };
}

async function encode(raw: Uint8Array, w: number, h: number, file: string): Promise<number> {
  await run([
    "ffmpeg", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-",
    "-q:v", "3", file,
  ], raw);
  return statSync(file).size;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const manifest: MaterialManifest = { layers: MATERIALS.length, entries: [], bytes: {} };

  for (const res of [MAT_RES_FULL, MAT_RES_REDUCED]) {
    const albedo = new Uint8Array(res * res * 3 * MATERIALS.length);
    const normal = new Uint8Array(res * res * 3 * MATERIALS.length);
    const rh = new Uint8Array(res * res * 3 * MATERIALS.length);

    for (let li = 0; li < MATERIALS.length; li++) {
      const m = MATERIALS[li];
      const dir = await source(m.acg);
      const colour = mapPath(dir, m.acg, "Color")!;
      const off = li * res * res * 3;
      albedo.set(await load(colour, res), off);
      normal.set(await load(mapPath(dir, m.acg, "NormalGL")!, res), off);
      const rough = await load(mapPath(dir, m.acg, "Roughness")!, res);
      const disp = await load(mapPath(dir, m.acg, "Displacement")!, res);
      const aoPath = mapPath(dir, m.acg, "AmbientOcclusion");
      const ao = aoPath ? await load(aoPath, res) : null;
      for (let i = 0; i < res * res; i++) {
        rh[off + i * 3] = rough[i * 3];
        rh[off + i * 3 + 1] = disp[i * 3];
        rh[off + i * 3 + 2] = ao ? ao[i * 3] : 255;
      }

      // Measured once, on the full-resolution set; the reduced set is the
      // same scan and inherits the same numbers.
      if (res === MAT_RES_FULL) {
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < res * res; i++) {
          r += toLinear(albedo[off + i * 3]);
          g += toLinear(albedo[off + i * 3 + 1]);
          b += toLinear(albedo[off + i * 3 + 2]);
        }
        const n = res * res;
        // The lattice is measured on the NORMAL map, not the height: a scan's
        // height carries metre-scale undulation that swamps the joints (Bricks086
        // correlates at 0.20 on its height and far higher on its normal), while
        // the normal's green channel is a spike at every bed joint and its red
        // channel one at every perpend, and nothing else.
        const nx = new Float32Array(n), ny = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          nx[i] = Math.abs(normal[off + i * 3] - 128);
          ny[i] = Math.abs(normal[off + i * 3 + 1] - 128);
        }
        const [sw, sh] = await sourceSize(colour);
        const lx = m.moduleM[0] > 0 ? latticeRepeats(nx, res, "x") : { repeats: 0, peak: 0 };
        const ly = m.moduleM[1] > 0 ? latticeRepeats(ny, res, "y") : { repeats: 0, peak: 0 };
        // Size from the module where the lattice was found, else the fallback.
        // A lattice the module says should be there and the scan does not show
        // is a bake failure, not a silent fallback: the scale would be a guess.
        if (m.moduleM[1] > 0 && ly.repeats === 0) throw new Error(`${m.acg}: no vertical lattice (peak ${ly.peak.toFixed(2)})`);
        const tileY = ly.repeats ? m.moduleM[1] * ly.repeats : m.fallbackM[1];
        // Across the course the SCAN'S OWN ASPECT sets the width once the course
        // height is known. The perpend lattice is noisier than the bed joints
        // (a running bond puts half the perpends out of phase), and on Bricks086
        // it found 9 bricks where 2.6 m of 203 mm units is 12.8, so it is only
        // trusted as a snap period when it agrees with the aspect within 10%.
        const tileX = m.moduleM[1] > 0 ? tileY * (sw / sh) : m.fallbackM[0];
        const expectX = m.moduleM[0] > 0 ? tileX / m.moduleM[0] : 0;
        const px = lx.repeats && Math.abs(lx.repeats - expectX) <= 0.1 * expectX ? lx.repeats : 0;
        // A running bond only repeats every TWO courses, so that is the snap.
        const py = ly.repeats && m.moduleM[0] > 0 ? Math.max(1, Math.floor(ly.repeats / 2)) : ly.repeats;
        manifest.entries.push({
          key: m.key,
          acg: m.acg,
          mean: [r / n, g / n, b / n].map((v) => Number(v.toFixed(5))) as [number, number, number],
          tileM: [Number(tileX.toFixed(3)), Number(tileY.toFixed(3))],
          period: [px, py],
        });
        console.log(
          `${m.key.padEnd(14)} ${m.acg.padEnd(13)} tile ${tileX.toFixed(2)} x ${tileY.toFixed(2)} m` +
          `  lattice ${lx.repeats}/${ly.repeats} (peaks ${lx.peak.toFixed(2)}/${ly.peak.toFixed(2)})` +
          `  mean ${(r / n).toFixed(3)} ${(g / n).toFixed(3)} ${(b / n).toFixed(3)}`,
        );
      }
    }

    const h = res * MATERIALS.length;
    let bytes = 0;
    bytes += await encode(albedo, res, h, `${OUT}/albedo-${res}.jpg`);
    bytes += await encode(normal, res, h, `${OUT}/normal-${res}.jpg`);
    bytes += await encode(rh, res, h, `${OUT}/rh-${res}.jpg`);
    manifest.bytes[String(res)] = bytes;
    console.log(`${res} px: ${(bytes / 1e6).toFixed(2)} MB`);
  }

  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 1) + "\n");
}

await main();
