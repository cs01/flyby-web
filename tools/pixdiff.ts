// Pixel difference between two screenshot sets, so a regression is measured
// rather than asserted.
//
// The shot harness already reports a 48x48 fingerprint delta, which is enough
// to say "these two runs of the same build agree" and nowhere near enough to
// say "this change did not touch the nine aerial poses". A change that moves
// one kerb line and a change that shifts every pixel by one count both come out
// tiny at 48x48; at full resolution they do not.
//
// No dependencies, so the PNG is decoded here: the shots are always 8-bit RGBA
// or RGB, non-interlaced, which is two filter cases and a zlib inflate.
//
//   bun tools/pixdiff.ts shots/before shots/after
//   bun tools/pixdiff.ts a.png b.png --out diff.png

import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";

interface Image {
  w: number;
  h: number;
  /** RGBA, 8 bits per channel. */
  data: Uint8Array;
}

function readChunks(buf: Uint8Array): { type: string; data: Uint8Array }[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8; // the PNG signature
  const out: { type: string; data: Uint8Array }[] = [];
  while (o + 8 <= buf.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    out.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len; // length, type, data, crc
  }
  return out;
}

export function decodePng(path: string): Image {
  const buf = new Uint8Array(readFileSync(path));
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error(`${path}: no IHDR`);
  const hv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const w = hv.getUint32(0);
  const h = hv.getUint32(4);
  const depth = ihdr.data[8];
  const colour = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) {
    throw new Error(`${path}: only 8-bit non-interlaced RGB/RGBA is supported (depth ${depth}, colour ${colour}, interlace ${interlace})`);
  }
  const ch = colour === 6 ? 4 : 3;

  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => Buffer.from(c.data)));
  const raw = new Uint8Array(inflateSync(idat));

  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[p + x];
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v: number;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${path}: unknown PNG filter ${filter}`);
      }
      line[x] = v & 0xff;
    }
    p += stride;
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = line[x * ch];
      out[(y * w + x) * 4 + 1] = line[x * ch + 1];
      out[(y * w + x) * 4 + 2] = line[x * ch + 2];
      out[(y * w + x) * 4 + 3] = ch === 4 ? line[x * ch + 3] : 255;
    }
    prev.set(line);
  }
  return { w, h, data: out };
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(img: Image): Uint8Array {
  const stride = img.w * 4;
  const raw = new Uint8Array((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.w);
  dv.setUint32(4, img.h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, q) => n + q.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

export interface Diff {
  /** Mean absolute difference over RGB, 0..255. */
  mean: number;
  /** Largest single-channel difference seen. */
  max: number;
  /** Fraction of pixels differing by more than 2 counts on any channel. */
  changed: number;
}

export function compare(a: Image, b: Image): Diff {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`size mismatch ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  let sum = 0;
  let max = 0;
  let changed = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.data[i * 4 + k] - b.data[i * 4 + k]);
      sum += d;
      if (d > worst) worst = d;
    }
    if (worst > max) max = worst;
    if (worst > 2) changed++;
  }
  return { mean: sum / (n * 3), max, changed: changed / n };
}

/** A visualisation: the base frame dimmed, with changed pixels in red. */
export function diffImage(a: Image, b: Image): Image {
  const out = new Uint8Array(a.w * a.h * 4);
  for (let i = 0; i < a.w * a.h; i++) {
    let worst = 0;
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a.data[i * 4 + k] - b.data[i * 4 + k]));
    const g = (a.data[i * 4] * 0.3 + a.data[i * 4 + 1] * 0.6 + a.data[i * 4 + 2] * 0.1) * 0.35;
    out[i * 4] = Math.min(255, g + worst * 3);
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = g;
    out[i * 4 + 3] = 255;
  }
  return { w: a.w, h: a.h, data: out };
}

function main(): void {
  const [aPath, bPath] = process.argv.slice(2).filter((s) => !s.startsWith("--"));
  const outIdx = process.argv.indexOf("--out");
  if (!aPath || !bPath) throw new Error("usage: bun tools/pixdiff.ts <before> <after> [--out dir-or-file]");

  const isDir = statSync(aPath).isDirectory();
  const pairs: [string, string, string][] = [];
  if (isDir) {
    for (const f of readdirSync(aPath).sort()) {
      if (!f.endsWith(".png") || f.endsWith("-repeat.png")) continue;
      if (existsSync(`${bPath}/${f}`)) pairs.push([f.replace(/\.png$/, ""), `${aPath}/${f}`, `${bPath}/${f}`]);
    }
  } else {
    pairs.push([aPath.split("/").pop()!.replace(/\.png$/, ""), aPath, bPath]);
  }

  for (const [name, af, bf] of pairs) {
    const a = decodePng(af);
    const b = decodePng(bf);
    const d = compare(a, b);
    console.log(
      `${name.padEnd(26)} mean ${d.mean.toFixed(3)}/255   max ${String(d.max).padStart(3)}   ` +
      `${(d.changed * 100).toFixed(2)}% of pixels moved`,
    );
    if (outIdx > 0) {
      const outArg = process.argv[outIdx + 1];
      const file = isDir ? `${outArg}/${name}.png` : outArg;
      writeFileSync(file, encodePng(diffImage(a, b)));
    }
  }
}

if (import.meta.main) main();
