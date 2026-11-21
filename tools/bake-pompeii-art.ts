// Restores the Pompeian paintings and mosaics fetched by
// tools/fetch-pompeii-art.ts and packs them into the atlas the town draws
// (public/landmarks/pompeii-art/): a 2048 px JPEG for desktop, a 1024 px one
// for phones, atlas.json with the tile rectangles, and CREDITS.md.
//
//   bun tools/fetch-pompeii-art.ts && bun tools/bake-pompeii-art.ts
//
// Restoration is deliberately modest, and the same four steps for every
// tile, so what is shown is the surviving painting and not a new one:
//   1. rectify: the photograph's panel (four corners, by eye) is resampled to
//      a flat rectangle at the work's real proportions;
//   2. lacunae: where the plaster shows through (bright, unsaturated, smooth,
//      and unlike the panel's ground) the hole is filled with the panel's
//      dominant ground colour, feathered at the edge. Figures are never
//      redrawn: a lost head stays a patch of red ground;
//   3. colour: saturation is lifted by a fixed factor (1.2-1.35) and the
//      luminance stretched between its 1st and 99th percentiles, toward the
//      fresh fresco the dulled, dusty surface was; no hue is moved;
//   4. a painted frame (dark band, ochre fillet, white line) round the
//      framed pictures, as the panels are framed on the walls.
// macOS only: image I/O goes through sips (tools/img.ts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ART_WORKS, type ArtAtlas } from "../src/data/pompeiiart";
import { ART_SOURCES } from "./pompeii-art-sources";
import { makeImg, readImage, resize, sample, writeImage, type Img } from "./img";

const CACHE = new URL("./.cache/pompeii-art/", import.meta.url).pathname;
const OUT = new URL("../public/landmarks/pompeii-art/", import.meta.url).pathname;
const ATLAS = 2048;
const GUTTER = 8;

interface Recipe {
  /** Source id in ART_SOURCES. */
  src: string;
  /** Panel corners in the photograph, fractions: TL, TR, BR, BL. */
  quad: [number, number, number, number, number, number, number, number];
  /** Tile size in the desktop atlas, px. */
  px: [number, number];
  lacunae: boolean;
  /** "all" a frame round it, "tb" top and bottom fillets only, "none". */
  frame: "all" | "tb" | "none";
  /** Saturation factor. */
  sat: number;
  /** Where the ground colour is measured, fractions x0,y0,x1,y1 of the tile: a stretch of plain ground picked by eye. */
  groundAt?: [number, number, number, number];
  /** The ground is the Pompeian red: measured over the strongly red pixels only. */
  red?: boolean;
}

const box = (x0: number, y0: number, x1: number, y1: number): Recipe["quad"] => [x0, y0, x1, y0, x1, y1, x0, y1];

// Corners read off a 10% grid laid over each photograph.
const RECIPES: Record<string, Recipe> = {
  "misteri-north": { src: "misteri-north", quad: [0.345, 0.19, 1.0, 0.13, 1.0, 0.7, 0.345, 0.73], px: [1024, 395], lacunae: false, frame: "tb", sat: 1.2, red: true },
  "misteri-east": { src: "misteri-east", quad: [0.0, 0.33, 0.79, 0.06, 0.79, 0.86, 0.0, 0.8], px: [760, 410], lacunae: true, frame: "tb", sat: 1.2, red: true },
  "vettii-ixion": { src: "vettii-ixion", quad: box(0.02, 0.02, 0.98, 0.98), px: [460, 504], lacunae: false, frame: "all", sat: 1.25 },
  "vettii-wall": { src: "vettii-fresco", quad: box(0.0, 0.0, 1.0, 0.95), px: [700, 486], lacunae: false, frame: "none", sat: 1.3 },
  "alexander": { src: "alexander-bw", quad: [0.035, 0.07, 0.975, 0.07, 0.975, 0.945, 0.035, 0.945], px: [1024, 551], lacunae: true, frame: "none", sat: 1.25 },
  "cave-canem": { src: "cave-canem-b", quad: box(0.0, 0.0, 1.0, 0.96), px: [400, 308], lacunae: false, frame: "none", sat: 1.1 },
  "faun-have": { src: "faun-have", quad: box(0.06, 0.27, 0.95, 0.72), px: [400, 158], lacunae: false, frame: "none", sat: 1.1 },
  "bronzi-fourth": { src: "bronzi-fourth", quad: box(0.05, 0.04, 0.95, 0.89), px: [520, 420], lacunae: false, frame: "none", sat: 1.1 },
  "vestali-wall": { src: "vestali-wall", quad: box(0.05, 0.05, 0.95, 0.92), px: [460, 420], lacunae: false, frame: "none", sat: 1.1 },
  "bazzani-fourth": { src: "bazzani-fourth", quad: box(0.03, 0.03, 0.97, 0.97), px: [450, 400], lacunae: false, frame: "none", sat: 1.1 },
  "seascape-black": { src: "seascape-black", quad: box(0.12, 0.0, 1.0, 1.0), px: [520, 420], lacunae: true, frame: "none", sat: 1.3 },
  "garden-room-1": { src: "garden-room-1", quad: box(0.02, 0.05, 0.98, 0.99), px: [300, 412], lacunae: true, frame: "none", sat: 1.2 },
  "garden-room-2": { src: "garden-room-2", quad: box(0.02, 0.05, 0.98, 0.99), px: [300, 412], lacunae: true, frame: "none", sat: 1.2 },
};

/** Resample the quad (bilinear corner interpolation: the photographs are near frontal). */
function rectify(src: Img, q: Recipe["quad"], w: number, h: number): Img {
  // Supersample 2x2 then box down, so a strong reduction does not alias.
  const W = w * 2, H = h * 2;
  const big = makeImg(W, H);
  const c = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const fx = (1 - v) * ((1 - u) * q[0] + u * q[2]) + v * ((1 - u) * q[6] + u * q[4]);
      const fy = (1 - v) * ((1 - u) * q[1] + u * q[3]) + v * ((1 - u) * q[7] + u * q[5]);
      sample(src, fx * src.w - 0.5, fy * src.h - 0.5, c);
      const d = (y * W + x) * 3;
      big.px[d] = c[0]; big.px[d + 1] = c[1]; big.px[d + 2] = c[2];
    }
  }
  return resize(big, w, h);
}

/** The most common colour, from a 4-bit-per-channel histogram, averaged within its bin. */
function dominant(img: Img, skip?: Float32Array): [number, number, number] {
  const n = new Uint32Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
  for (let i = 0; i < img.w * img.h; i++) {
    if (skip && skip[i] > 0.5) continue;
    const r = img.px[i * 3], g = img.px[i * 3 + 1], b = img.px[i * 3 + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    n[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
  }
  let best = 0;
  for (let k = 1; k < 4096; k++) if (n[k] > n[best]) best = k;
  return [sr[best] / n[best], sg[best] / n[best], sb[best] / n[best]];
}

/** Box blur of a scalar field, radius r, by running sums. */
function blur(f: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += f[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += f[y * w + Math.min(w - 1, x + r + 1)] - f[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function hash(x: number, y: number): number {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

interface Restored { img: Img; ground: [number, number, number]; lacunaShare: number }

function restore(raw: Img, r: Recipe): Restored {
  const { w, h } = raw;
  const img: Img = { w, h, px: raw.px.slice() };
  const N = w * h;
  // --- 2. lacunae ---
  const groundOf = (skip?: Float32Array): [number, number, number] => {
    if (r.red) {
      const m = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < w * h; i++) {
        const R = img.px[i * 3], G = img.px[i * 3 + 1], B = img.px[i * 3 + 2];
        if ((skip && skip[i] > 0.5) || R < 1.7 * G || R < 1.7 * B || R < 90) continue;
        m[0] += R; m[1] += G; m[2] += B; n++;
      }
      return [m[0] / n, m[1] / n, m[2] / n];
    }
    if (!r.groundAt) return dominant(img, skip);
    const [x0, y0, x1, y1] = r.groundAt;
    const sub = makeImg(Math.round((x1 - x0) * w), Math.round((y1 - y0) * h));
    for (let y = 0; y < sub.h; y++) for (let x = 0; x < sub.w; x++) for (let c = 0; c < 3; c++) {
      sub.px[(y * sub.w + x) * 3 + c] = img.px[((Math.round(y0 * h) + y) * w + Math.round(x0 * w) + x) * 3 + c];
    }
    // The mean, not a histogram peak: a small plain patch, lit unevenly.
    const m = [0, 0, 0];
    for (let i = 0; i < sub.w * sub.h; i++) for (let c = 0; c < 3; c++) m[c] += sub.px[i * 3 + c] / (sub.w * sub.h);
    return [m[0], m[1], m[2]];
  };
  let ground = groundOf();
  let lacunaShare = 0;
  if (r.lacunae) {
    const L = new Float32Array(N), L2 = new Float32Array(N), S = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const R = img.px[i * 3] / 255, G = img.px[i * 3 + 1] / 255, B = img.px[i * 3 + 2] / 255;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      L[i] = (R + G + B) / 3; L2[i] = L[i] * L[i]; S[i] = mx > 0 ? (mx - mn) / mx : 0;
    }
    const mL = blur(L, w, h, 3), mL2 = blur(L2, w, h, 3);
    const gL = (ground[0] + ground[1] + ground[2]) / 765;
    const raw01 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const sd = Math.sqrt(Math.max(0, mL2[i] - mL[i] * mL[i]));
      const dg = Math.hypot(img.px[i * 3] - ground[0], img.px[i * 3 + 1] - ground[1], img.px[i * 3 + 2] - ground[2]) / 255;
      // Bare plaster: pale, little colour, smooth, and not the ground itself.
      raw01[i] = L[i] > Math.max(0.5, gL + 0.12) && S[i] < 0.5 && sd < 0.09 && dg > 0.3 ? 1 : 0;
    }
    // Opening by blur-and-threshold drops specks (a white tessera, a
    // highlight on a figure); a second blur feathers the fill's edge.
    const opened = blur(raw01, w, h, 4);
    const mask = new Float32Array(N);
    for (let i = 0; i < N; i++) mask[i] = opened[i] > 0.5 ? 1 : 0;
    const grown = blur(mask, w, h, 5);
    for (let i = 0; i < N; i++) mask[i] = Math.min(1, grown[i] * 1.6);
    ground = groundOf(mask);
    for (let i = 0; i < N; i++) {
      if (mask[i] <= 0) continue;
      lacunaShare += mask[i] > 0.5 ? 1 : 0;
      const x = i % w, y = (i / w) | 0;
      // A little of the fresco's own texture, so a fill does not read as a flat decal.
      const t = 0.96 + 0.08 * (0.6 * hash(x >> 1, y >> 1) + 0.4 * hash(x >> 3, (y >> 3) + 999));
      for (let c = 0; c < 3; c++) img.px[i * 3 + c] = img.px[i * 3 + c] * (1 - mask[i]) + Math.min(255, ground[c] * t) * mask[i];
    }
    lacunaShare /= N;
  }
  // --- 3. colour ---
  const lum: number[] = [];
  for (let i = 0; i < N; i += 7) lum.push((img.px[i * 3] + img.px[i * 3 + 1] + img.px[i * 3 + 2]) / 3);
  lum.sort((a, b) => a - b);
  const lo = lum[Math.floor(lum.length * 0.01)], hi = lum[Math.floor(lum.length * 0.99)];
  const stretch = (v: number): number => 6 + ((v - lo) / Math.max(1, hi - lo)) * 243;
  for (let i = 0; i < N; i++) {
    const R = img.px[i * 3], G = img.px[i * 3 + 1], B = img.px[i * 3 + 2];
    const l = (R + G + B) / 3;
    const l2 = l + (stretch(l) - l) * 0.6;
    for (let c = 0; c < 3; c++) {
      const v = img.px[i * 3 + c];
      const lifted = l + (v - l) * r.sat;
      img.px[i * 3 + c] = Math.max(0, Math.min(255, lifted + (l2 - l)));
    }
  }
  // --- 4. the painted frame ---
  if (r.frame !== "none") {
    const t = Math.round(Math.min(w, h) * 0.035), f = Math.max(2, Math.round(t * 0.3)), wl = Math.max(1, Math.round(t * 0.12));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dEdge = r.frame === "all" ? Math.min(x, y, w - 1 - x, h - 1 - y) : Math.min(y, h - 1 - y);
      let c: [number, number, number] | null = null;
      if (dEdge < t) c = [70, 16, 12];
      else if (dEdge < t + f) c = [196, 150, 62];
      else if (dEdge < t + f + wl) c = [232, 226, 206];
      if (c) for (let k = 0; k < 3; k++) img.px[(y * w + x) * 3 + k] = c[k];
    }
  }
  return { img, ground: [ground[0] / 255, ground[1] / 255, ground[2] / 255], lacunaShare };
}

/** Shelf packing: each row opened by the tallest tile left, then filled with whatever still fits across. */
function pack(sizes: [number, number][], S: number): [number, number][] {
  const left = sizes.map((_, i) => i).sort((a, b) => sizes[b][1] - sizes[a][1]);
  const at: [number, number][] = new Array(sizes.length);
  let y = 0;
  while (left.length) {
    let x = 0, rowH = 0;
    for (let k = 0; k < left.length; ) {
      const [w, h] = sizes[left[k]];
      if (x + w + GUTTER * 2 <= S) {
        at[left[k]] = [x + GUTTER, y + GUTTER];
        x += w + GUTTER * 2;
        rowH = Math.max(rowH, h + GUTTER * 2);
        left.splice(k, 1);
      } else k++;
    }
    y += rowH;
    if (y > S) throw new Error("pompeii art: atlas full");
  }
  return at;
}

function blit(dst: Img, src: Img, ox: number, oy: number, gutter: number): void {
  // Edge pixels copied out into the gutter so mipmaps do not bleed the neighbour in.
  for (let y = -gutter; y < src.h + gutter; y++) for (let x = -gutter; x < src.w + gutter; x++) {
    const sx = Math.max(0, Math.min(src.w - 1, x)), sy = Math.max(0, Math.min(src.h - 1, y));
    const dx = ox + x, dy = oy + y;
    if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue;
    for (let c = 0; c < 3; c++) dst.px[(dy * dst.w + dx) * 3 + c] = src.px[(sy * src.w + sx) * 3 + c];
  }
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const meta = JSON.parse(readFileSync(`${CACHE}meta.json`, "utf8")) as Record<string, { title: string; licence: string; artist: string; page: string; width: number; height: number }>;
  const tiles: Restored[] = [];
  const before: Img[] = [];
  for (const wk of ART_WORKS) {
    const r = RECIPES[wk.id];
    if (!r) throw new Error(`no recipe for ${wk.id}`);
    if (!ART_SOURCES.some((s) => s.id === r.src)) throw new Error(`${wk.id}: source ${r.src} not fetched`);
    const src = readImage(`${CACHE}${r.src}.jpg`);
    const raw = rectify(src, r.quad, r.px[0], r.px[1]);
    before.push(raw);
    const t = restore(raw, r);
    tiles.push(t);
    console.log(`${wk.id.padEnd(16)} ${r.px[0]}x${r.px[1]}  lacunae ${(t.lacunaShare * 100).toFixed(1)}%  ground ${t.ground.map((v) => v.toFixed(2)).join(",")}`);
  }
  const at = pack(tiles.map((t) => [t.img.w, t.img.h]), ATLAS);
  const atlas = makeImg(ATLAS, ATLAS);
  tiles.forEach((t, i) => blit(atlas, t.img, at[i][0], at[i][1], GUTTER));
  const desc: ArtAtlas = {
    size: ATLAS,
    tiles: tiles.map((t, i) => ({ id: ART_WORKS[i].id, rect: [at[i][0], at[i][1], t.img.w, t.img.h], ground: t.ground.map((v) => Math.round(v * 1000) / 1000) as [number, number, number] })),
  };
  writeImage(atlas, `${OUT}atlas.jpg`, 84);
  writeImage(resize(atlas, ATLAS / 2, ATLAS / 2), `${OUT}atlas-small.jpg`, 82);
  writeFileSync(`${OUT}atlas.json`, JSON.stringify(desc));
  // Before and after, side by side, for review (not shipped).
  const rows = tiles.map((t, i) => [before[i], t.img] as const);
  const sw = 1100, sh = rows.reduce((s, [b]) => s + Math.round(b.h * (540 / b.w)) + 6, 0);
  const sheet = makeImg(sw, sh);
  let y = 0;
  for (const [b, a] of rows) {
    const hh = Math.round(b.h * (540 / b.w));
    blit(sheet, resize(b, 540, hh), 0, y, 0);
    blit(sheet, resize(a, 540, hh), 556, y, 0);
    y += hh + 6;
  }
  writeImage(sheet, new URL("./.cache/pompeii-art-before-after.jpg", import.meta.url).pathname, 80);
  // Credits: every file a tile was made from.
  const used = [...new Set(ART_WORKS.map((w) => RECIPES[w.id].src))];
  const lines = [
    "# Pompeii art atlas: sources",
    "",
    "Restored by tools/bake-pompeii-art.ts from these Wikimedia Commons files (rectified, lacunae filled with the",
    "panel's ground colour, saturation and contrast lifted modestly, painted frames added). Each tile is a derivative",
    "of its source under the source's licence; CC BY-SA sources keep that licence for their tile.",
    "",
    "| tile(s) | work | source | author | licence |",
    "|---|---|---|---|---|",
  ];
  for (const s of used) {
    const m = meta[s];
    if (!m) throw new Error(`${s}: no metadata; run tools/fetch-pompeii-art.ts`);
    const ws = ART_WORKS.filter((w) => RECIPES[w.id].src === s);
    lines.push(`| ${ws.map((w) => w.id).join(", ")} | ${ws.map((w) => w.title).join("; ")} | [${m.title.replace(/^File:/, "")}](${m.page}) | ${m.artist.replace(/\|/g, "/")} | ${m.licence} |`);
  }
  writeFileSync(`${OUT}CREDITS.md`, lines.join("\n") + "\n");
  console.log(`wrote ${OUT}atlas.jpg, atlas-small.jpg, atlas.json, CREDITS.md`);
}

main();
