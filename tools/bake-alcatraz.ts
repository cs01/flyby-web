// Bakes Alcatraz Island into public/landmarks/: a 1 m lidar heightfield, a
// z19 orthophoto drape (full and phone sizes) and the OSM outlines of the
// buildings, walls and piers the runtime models (src/render/alcatraz.ts).
//
// Sources, all keyless:
//   * USGS 3DEP bare-earth DEM via the National Map ImageServer exportImage,
//     resampled by the server onto a lat/lon grid of 1e-5 degree cells.
//   * Esri World Imagery z19, the same tile server the app's stitcher uses.
//   * OSM via Overpass.
//
// Downloads are cached under ~/.cache/flyby-web-bake/alcatraz so a re-bake
// after a format change does not hit the servers again. Needs ffmpeg (the
// same dependency tools/bake-materials.ts has) to decode and encode JPEG.
//
//   bun tools/bake-alcatraz.ts            (uses the cache when present)
//   bun tools/bake-alcatraz.ts --refetch  (ignores it)

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import {
  ALCATRAZ_BBOX,
  ALCATRAZ_CELL_DEG,
  encodeHeights,
  type AlcatrazFeature,
  type AlcatrazMeta,
} from "../src/data/alcatraz";
import { latToTileY, lonToTileX } from "../src/geo";

declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): never };

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);
const OUT = `${ROOT}public/landmarks`;
const CACHE = `${process.env["FLYBY_CACHE"] ?? `${process.env["HOME"]}/.cache/flyby-web-bake`}/alcatraz`;
const REFETCH = process.argv.includes("--refetch");
const UA = "flyby-web bake-alcatraz";

const DRAPE_ZOOM = 19;
/** Full-tier drape width; the phone drape is DRAPE_SMALL wide. */
const DRAPE_FULL = 2048;
const DRAPE_SMALL = 512;

async function run(cmd: string[], input?: Uint8Array): Promise<Uint8Array> {
  const p = Bun.spawn(cmd, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (input) {
    p.stdin!.write(input);
    p.stdin!.end();
  }
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${(await new Response(p.stderr).text()).slice(0, 400)}`);
  return out;
}

/** A cached download: `fetchFn` runs only when the file is absent or --refetch. */
async function cached(name: string, fetchFn: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const path = `${CACHE}/${name}`;
  if (!REFETCH && existsSync(path)) return new Uint8Array(await Bun.file(path).arrayBuffer());
  const bytes = await fetchFn();
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

async function get(url: string, init?: RequestInit): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(90_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}: ${err}`);
      await Bun.sleep(2000 * (attempt + 1));
    }
  }
}

// --- DEM ---------------------------------------------------------------------

/** A float32 GeoTIFF as the ImageServer writes it: uncompressed, tiled or stripped. */
function parseTiff(buf: Uint8Array): { w: number; h: number; data: Float32Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint16(0, true) !== 0x4949) throw new Error("expected a little-endian TIFF");
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12;
    const tag = dv.getUint16(o, true);
    const type = dv.getUint16(o + 2, true);
    const cnt = dv.getUint32(o + 4, true);
    if (type !== 3 && type !== 4) continue;
    const sz = type === 3 ? 2 : 4;
    const at = cnt * sz <= 4 ? o + 8 : dv.getUint32(o + 8, true);
    const vals: number[] = [];
    for (let k = 0; k < cnt; k++) vals.push(type === 3 ? dv.getUint16(at + k * 2, true) : dv.getUint32(at + k * 4, true));
    tags.set(tag, vals);
  }
  const w = tags.get(256)![0];
  const h = tags.get(257)![0];
  if ((tags.get(259)?.[0] ?? 1) !== 1) throw new Error("compressed TIFF; ask the server for an uncompressed one");
  if (tags.get(258)?.[0] !== 32 || tags.get(339)?.[0] !== 3) throw new Error("expected float32 samples");
  const data = new Float32Array(w * h);
  const put = (off: number, ox: number, oy: number, tw: number, th: number): void => {
    for (let r = 0; r < th; r++) {
      for (let c = 0; c < tw; c++) {
        const x = ox + c;
        const y = oy + r;
        if (x < w && y < h) data[y * w + x] = dv.getFloat32(off + (r * tw + c) * 4, true);
      }
    }
  };
  if (tags.has(324)) {
    const tw = tags.get(322)![0];
    const th = tags.get(323)![0];
    const across = Math.ceil(w / tw);
    tags.get(324)!.forEach((off, t) => put(off, (t % across) * tw, Math.floor(t / across) * th, tw, th));
  } else {
    const rps = tags.get(278)?.[0] ?? h;
    tags.get(273)!.forEach((off, s) => put(off, 0, s * rps, w, Math.min(rps, h - s * rps)));
  }
  return { w, h, data };
}

async function bakeDem(): Promise<{ w: number; h: number; heights: Float32Array; waterOffset: number }> {
  const b = ALCATRAZ_BBOX;
  const w = Math.round((b.east - b.west) / ALCATRAZ_CELL_DEG);
  const h = Math.round((b.north - b.south) / ALCATRAZ_CELL_DEG);
  const tif = await cached(`dem-${w}x${h}.tif`, async () => {
    const q = new URLSearchParams({
      bbox: `${b.west},${b.south},${b.east},${b.north}`,
      bboxSR: "4326",
      imageSR: "4326",
      size: `${w},${h}`,
      format: "tiff",
      pixelType: "F32",
      noData: "-9999",
      interpolation: "RSP_BilinearInterpolation",
      f: "json",
    });
    const meta = JSON.parse(new TextDecoder().decode(
      await get(`https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?${q}`),
    )) as { href: string; width: number; height: number };
    if (meta.width !== w || meta.height !== h) throw new Error(`server returned ${meta.width}x${meta.height}, asked ${w}x${h}`);
    return get(meta.href);
  });
  const dem = parseTiff(tif);
  if (dem.w !== w || dem.h !== h) throw new Error(`tiff is ${dem.w}x${dem.h}`);

  // 3DEP is hydro-flattened: open water is one constant elevation (about
  // -0.4 m NAVD88 here). The renderer's sea surface is at 0, so the most
  // common sub-metre value becomes 0 and the island rises with it. Without
  // this every shore would stand in 0.4 m of water.
  const hist = new Map<number, number>();
  for (const v of dem.data) if (v > -5 && v < 1) hist.set(Math.round(v * 100), (hist.get(Math.round(v * 100)) ?? 0) + 1);
  let mode = 0;
  let best = -1;
  for (const [k, c] of hist) if (c > best) { best = c; mode = k; }
  const waterOffset = -mode / 100;
  const heights = new Float32Array(w * h);
  for (let i = 0; i < heights.length; i++) {
    const v = dem.data[i];
    heights[i] = v < -1000 ? 0 : Math.max(0, v + waterOffset);
  }
  return { w, h, heights, waterOffset };
}

// --- OSM ---------------------------------------------------------------------

interface OsmWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function bakeOsm(): Promise<AlcatrazFeature[]> {
  const b = ALCATRAZ_BBOX;
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  const q = `[out:json][timeout:60];(way(${box})[building];way(${box})["building:part"];way(${box})[barrier~"^(wall|retaining_wall)$"];way(${box})[man_made~"^(pier|lighthouse|water_tower|chimney|tower)$"];way(${box})[name="Recreation Yard"];);out tags geom;`;
  const raw = await cached("osm.json", async () => {
    let last = "";
    for (const url of OVERPASS) {
      try {
        const t = await get(url, {
          method: "POST",
          body: `data=${encodeURIComponent(q)}`,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        if (new TextDecoder().decode(t.slice(0, 400)).includes('"elements"')) return t;
        last = `${url}: not JSON`;
      } catch (err) {
        last = String(err);
      }
    }
    throw new Error(`overpass failed: ${last}`);
  });
  const ways = (JSON.parse(new TextDecoder().decode(raw)) as { elements: OsmWay[] }).elements;
  const keep = ["name", "building", "building:part", "building:levels", "height", "roof:shape", "barrier", "man_made", "historic", "building:colour"];
  const out: AlcatrazFeature[] = [];
  for (const e of ways) {
    if (e.type !== "way" || !e.geometry || e.geometry.length < 2 || !e.tags) continue;
    const tags: Record<string, string> = {};
    for (const k of keep) if (e.tags[k] !== undefined) tags[k] = e.tags[k];
    out.push({
      id: e.id,
      tags,
      // 1e-7 degrees is 1 cm: the precision OSM itself stores.
      ll: e.geometry.flatMap((p) => [Math.round(p.lat * 1e7) / 1e7, Math.round(p.lon * 1e7) / 1e7]),
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

// --- drape -------------------------------------------------------------------

/** The land's bounding box plus a margin, from the heightfield. */
function landBbox(w: number, h: number, heights: Float32Array, marginM: number): AlcatrazMeta["drape"]["bbox"] {
  let x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (heights[y * w + x] <= 0.3) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const b = ALCATRAZ_BBOX;
  const mLat = 111_000;
  const mLon = mLat * Math.cos((37.827 * Math.PI) / 180);
  return {
    west: Math.max(b.west, b.west + x0 * ALCATRAZ_CELL_DEG - marginM / mLon),
    east: Math.min(b.east, b.west + (x1 + 1) * ALCATRAZ_CELL_DEG + marginM / mLon),
    north: Math.min(b.north, b.north - y0 * ALCATRAZ_CELL_DEG + marginM / mLat),
    south: Math.max(b.south, b.north - (y1 + 1) * ALCATRAZ_CELL_DEG - marginM / mLat),
  };
}

async function decodeJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  return run(["ffmpeg", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], bytes);
}

async function encodeJpeg(rgb: Uint8Array, w: number, h: number, file: string, outW: number, outH: number): Promise<number> {
  await run([
    "ffmpeg", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-",
    "-vf", `scale=${outW}:${outH}:flags=area`, "-q:v", "4", file,
  ], rgb);
  return statSync(file).size;
}

async function bakeDrape(bbox: AlcatrazMeta["drape"]["bbox"], slopeAt: ((lat: number, lon: number) => number) | null): Promise<{ w: number; h: number; small: [number, number] }> {
  const z = DRAPE_ZOOM;
  const tx0 = Math.floor(lonToTileX(bbox.west, z));
  const tx1 = Math.floor(lonToTileX(bbox.east, z));
  const ty0 = Math.floor(latToTileY(bbox.north, z));
  const ty1 = Math.floor(latToTileY(bbox.south, z));
  const nx = tx1 - tx0 + 1;
  const ny = ty1 - ty0 + 1;
  const W = nx * 256;
  const mosaic = new Uint8Array(W * ny * 256 * 3);
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push((async () => {
        const jpg = await cached(`tiles/${z}/${ty}/${tx}.jpg`, () =>
          get(`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`));
        const rgb = await decodeJpeg(jpg);
        if (rgb.length !== 256 * 256 * 3) throw new Error(`tile ${z}/${ty}/${tx} is not 256x256`);
        const ox = (tx - tx0) * 256;
        const oy = (ty - ty0) * 256;
        for (let r = 0; r < 256; r++) mosaic.set(rgb.subarray(r * 768, r * 768 + 768), ((oy + r) * W + ox) * 3);
      })());
      // A handful at a time: the tile server rate-limits bursts.
      if (jobs.length % 8 === 0) await Promise.all(jobs.slice(-8));
    }
  }
  await Promise.all(jobs);

  // Resample onto a grid LINEAR in lat/lon, which is what the patch's uvs
  // are; over 500 m the Mercator stretch is a few centimetres, but sampling
  // through the projection costs nothing and leaves no error to argue about.
  const mPerPx = (156543.034 * Math.cos((37.827 * Math.PI) / 180)) / 2 ** z;
  const spanX = (bbox.east - bbox.west) * 111_000 * Math.cos((37.827 * Math.PI) / 180);
  const spanY = (bbox.north - bbox.south) * 111_000;
  const ow = Math.round(spanX / mPerPx);
  const oh = Math.round(spanY / mPerPx);
  const out = new Uint8Array(ow * oh * 3);
  for (let j = 0; j < oh; j++) {
    const lat = bbox.north - ((j + 0.5) / oh) * (bbox.north - bbox.south);
    const fy = (latToTileY(lat, z) - ty0) * 256 - 0.5;
    for (let i = 0; i < ow; i++) {
      const lon = bbox.west + ((i + 0.5) / ow) * (bbox.east - bbox.west);
      const fx = (lonToTileX(lon, z) - tx0) * 256 - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const y0 = Math.max(0, Math.floor(fy));
      const x1 = Math.min(W - 1, x0 + 1);
      const y1 = Math.min(ny * 256 - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const p = (x: number, y: number): number => mosaic[(y * W + x) * 3 + c];
        const v = (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) + (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
        out[(j * ow + i) * 3 + c] = Math.round(v);
      }
    }
  }
  // Cliff faces. An orthophoto sees a 20 m cliff as a few pixels of whatever
  // is at its lip (here mostly sunlit white rock and guano), and the mesh then
  // stretches those pixels down the whole face, which read as white curtains
  // from the ferry. Where the lidar is steeper than ~40 degrees the drape is
  // pulled toward the island's weathered grey-brown greywacke, keeping the
  // photo's own light and dark so the texture is still the rock's.
  if (slopeAt) {
    const rock = [104, 96, 86];
    for (let j = 0; j < oh; j++) {
      const lat = bbox.north - ((j + 0.5) / oh) * (bbox.north - bbox.south);
      for (let i = 0; i < ow; i++) {
        const lon = bbox.west + ((i + 0.5) / ow) * (bbox.east - bbox.west);
        const s = slopeAt(lat, lon);
        const t = Math.max(0, Math.min(1, (s - 0.75) / (1.6 - 0.75)));
        if (t <= 0) continue;
        const k = (j * ow + i) * 3;
        const lum = (out[k] * 0.3 + out[k + 1] * 0.59 + out[k + 2] * 0.11) / 160;
        const w = 0.75 * t * t * (3 - 2 * t);
        for (let c = 0; c < 3; c++) out[k + c] = Math.round(out[k + c] * (1 - w) + rock[c] * (0.6 + 0.5 * lum) * w);
      }
    }
  }
  const fw = DRAPE_FULL;
  const fh = Math.round((oh / ow) * fw);
  const sw = DRAPE_SMALL;
  const sh = Math.round((oh / ow) * sw);
  const big = await encodeJpeg(out, ow, oh, `${OUT}/alcatraz-drape.jpg`, fw, fh);
  const small = await encodeJpeg(out, ow, oh, `${OUT}/alcatraz-drape-small.jpg`, sw, sh);
  console.log(`  drape ${ow}x${oh} native z${z} -> ${fw}x${fh} (${(big / 1024).toFixed(0)} kB), ${sw}x${sh} (${(small / 1024).toFixed(0)} kB)`);
  return { w: fw, h: fh, small: [sw, sh] };
}

/** Rise over run (tan of the slope) of the lidar at a point, from central differences. */
function slopeOf(w: number, h: number, hs: Float32Array): (lat: number, lon: number) => number {
  const b = ALCATRAZ_BBOX;
  const dx = ALCATRAZ_CELL_DEG * 111_132 * Math.cos((37.827 * Math.PI) / 180);
  const dz = ALCATRAZ_CELL_DEG * 111_132;
  return (lat, lon) => {
    const x = Math.max(1, Math.min(w - 2, Math.round((lon - b.west) / ALCATRAZ_CELL_DEG - 0.5)));
    const y = Math.max(1, Math.min(h - 2, Math.round((b.north - lat) / ALCATRAZ_CELL_DEG - 0.5)));
    const gx = (hs[y * w + x + 1] - hs[y * w + x - 1]) / (2 * dx);
    const gz = (hs[(y + 1) * w + x] - hs[(y - 1) * w + x]) / (2 * dz);
    return Math.hypot(gx, gz);
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log("alcatraz: dem");
  const dem = await bakeDem();
  let max = 0;
  for (const v of dem.heights) max = Math.max(max, v);
  console.log(`  ${dem.w}x${dem.h} cells, water offset ${dem.waterOffset.toFixed(2)} m, max ${max.toFixed(1)} m`);
  console.log("alcatraz: osm");
  const features = await bakeOsm();
  console.log(`  ${features.length} ways`);
  console.log("alcatraz: drape");
  const dbbox = landBbox(dem.w, dem.h, dem.heights, 25);
  const drape = await bakeDrape(dbbox, slopeOf(dem.w, dem.h, dem.heights));

  const heightBytes = encodeHeights(dem.heights);
  writeFileSync(`${OUT}/alcatraz.height`, heightBytes);
  const meta: AlcatrazMeta = {
    version: 1,
    bbox: ALCATRAZ_BBOX,
    w: dem.w,
    h: dem.h,
    drape: { bbox: dbbox, size: [drape.w, drape.h], small: drape.small },
    features,
    sources: "USGS 3DEP 1 m DEM (public domain); Esri World Imagery; (c) OpenStreetMap contributors, ODbL",
  };
  writeFileSync(`${OUT}/alcatraz.json`, JSON.stringify(meta));
  let total = 0;
  for (const f of ["alcatraz.json", "alcatraz.height", "alcatraz-drape.jpg", "alcatraz-drape-small.jpg"]) {
    const s = statSync(`${OUT}/${f}`).size;
    total += s;
    console.log(`  ${f.padEnd(26)} ${(s / 1024).toFixed(0)} kB`);
  }
  console.log(`  total ${(total / 1048576).toFixed(2)} MB`);
}

await main();
