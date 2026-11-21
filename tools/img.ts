// Just enough raster I/O for the bake tools, with no image library: macOS
// `sips` converts any format to and from uncompressed BMP, and this reads
// and writes that BMP. RGB, 8 bits a channel, top row first.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export interface Img { w: number; h: number; px: Uint8Array }

export function makeImg(w: number, h: number): Img {
  return { w, h, px: new Uint8Array(w * h * 3) };
}

function sips(args: string[]): void {
  const r = Bun.spawnSync(["sips", ...args], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`sips ${args.join(" ")}: ${r.stderr.toString()}`);
}

let seq = 0;
const tmp = (ext: string): string => `${tmpdir()}/img-${process.pid}-${seq++}.${ext}`;

/** Any format sips reads (JPEG, PNG, TIFF...) to RGB. */
export function readImage(path: string): Img {
  const bmp = tmp("bmp");
  sips(["-s", "format", "bmp", path, "--out", bmp]);
  const b = readFileSync(bmp);
  unlinkSync(bmp);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hs = b.readInt32LE(22), bpp = b.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`${path}: ${bpp}-bit BMP`);
  const h = Math.abs(hs), bytes = bpp / 8, stride = Math.ceil((w * bytes) / 4) * 4;
  const img = makeImg(w, h);
  for (let y = 0; y < h; y++) {
    const row = hs < 0 ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = off + row * stride + x * bytes, d = (y * w + x) * 3;
      img.px[d] = b[s + 2]; img.px[d + 1] = b[s + 1]; img.px[d + 2] = b[s];
    }
  }
  return img;
}

/** Write as JPEG at a quality 0-100 (or PNG when the path ends .png). */
export function writeImage(img: Img, path: string, quality = 85): void {
  const stride = Math.ceil((img.w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + stride * img.h);
  b.write("BM", 0); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(img.w, 18); b.writeInt32LE(-img.h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(stride * img.h, 34);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const s = (y * img.w + x) * 3, d = 54 + y * stride + x * 3;
    b[d] = img.px[s + 2]; b[d + 1] = img.px[s + 1]; b[d + 2] = img.px[s];
  }
  const bmp = tmp("bmp");
  writeFileSync(bmp, b);
  const png = path.endsWith(".png");
  sips(["-s", "format", png ? "png" : "jpeg", ...(png ? [] : ["-s", "formatOptions", String(quality)]), bmp, "--out", path]);
  unlinkSync(bmp);
}

/** Bilinear sample, x and y in pixels; clamps at the edges. Writes rgb into out. */
export function sample(img: Img, x: number, y: number, out: Float32Array | number[]): void {
  const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(img.h - 1, Math.floor(y)));
  const x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  for (let c = 0; c < 3; c++) {
    const a = img.px[(y0 * img.w + x0) * 3 + c], b = img.px[(y0 * img.w + x1) * 3 + c];
    const d = img.px[(y1 * img.w + x0) * 3 + c], e = img.px[(y1 * img.w + x1) * 3 + c];
    out[c] = (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
  }
}

/** Box-filtered resize: averages every source pixel under each target pixel, so a big reduction does not alias. */
export function resize(img: Img, w: number, h: number): Img {
  const out = makeImg(w, h);
  const sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < img.h; yy++) for (let xx = x0; xx < x1 && xx < img.w; xx++) {
      const s = (yy * img.w + xx) * 3;
      r += img.px[s]; g += img.px[s + 1]; b += img.px[s + 2]; n++;
    }
    const d = (y * w + x) * 3;
    out.px[d] = r / n; out.px[d + 1] = g / n; out.px[d + 2] = b / n;
  }
  return out;
}
