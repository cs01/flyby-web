// Repaints the C182's factory livery from grey to navy, and downsizes it.
//
// The upstream atlas is a white aeroplane with a GREY sweep down the fuselage.
// The reference photographs this app is matching are the same aeroplane with
// the sweep in navy, so this is a hue change on one part of one texture rather
// than a repaint of anything.
//
// Done as a bake step rather than in the shader because the sweep is a region
// of a texture, not a material: nothing at runtime knows which fragments are
// "the stripe". Doing it here also keeps it out of the frame budget entirely.
//
// The selection rule is the interesting part. The stripe cannot be picked out
// by colour alone -- it is grey, and so is every shaded part of a white
// fuselage. What separates them is VALUE: the white shell sits above ~0.72
// even in shade, the stripe sits between 0.22 and 0.68, and the panel lines and
// registration text sit below 0.22. So the rule is a value window, plus a
// saturation cap so the red/green nav lenses and the wheels are left alone, and
// a UV gate that keeps it off the wings (which are white on top and grey
// underneath -- exactly the value the stripe occupies).
//
//   bun tools/recolor-livery.ts

import { inflateSync, deflateSync } from "node:zlib";

const SRC = "assets-src/c182s/Default.png";
const OUT = "public/aircraft/c182-default.png";

/** Output size. The airframe is never more than ~600 px tall on screen. */
const OUT_W = 2048;
const OUT_H = 1024;

/** Navy, at the value the stripe's mid-tone sits at. From the reference photos. */
const NAVY = { r: 0.055, g: 0.114, b: 0.29 };
const NAVY_PIVOT = 0.5;

/** Value window the stripe occupies, and the saturation ceiling for "grey". */
const V_LO = 0.22;
const V_HI = 0.68;
const S_MAX = 0.16;

interface Image {
  w: number;
  h: number;
  px: Uint8Array; // RGBA
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function decodePng(buf: Uint8Array): Image {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0) !== 0x89504e47) throw new Error("not a PNG");
  let o = 8;
  let w = 0;
  let h = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idat: Uint8Array[] = [];

  while (o < buf.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      bitDepth = buf[o + 16];
      colorType = buf[o + 17];
      if (buf[o + 19] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  if (!channels) throw new Error(`colour type ${colorType} not supported`);

  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const stride = w * channels;
  const px = new Uint8Array(w * h * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let p = 0;

  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    line.set(raw.subarray(p, p + stride));
    p += stride;
    // Undo the per-scanline filter. Paeth is the one worth reading twice.
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 1: line[x] = (line[x] + a) & 255; break;
        case 2: line[x] = (line[x] + b) & 255; break;
        case 3: line[x] = (line[x] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
      }
    }
    for (let x = 0; x < w; x++) {
      const s = x * channels;
      const d = (y * w + x) * 4;
      if (channels >= 3) {
        px[d] = line[s];
        px[d + 1] = line[s + 1];
        px[d + 2] = line[s + 2];
        px[d + 3] = channels === 4 ? line[s + 3] : 255;
      } else {
        px[d] = px[d + 1] = px[d + 2] = line[s];
        px[d + 3] = channels === 2 ? line[s + 1] : 255;
      }
    }
    prev.set(line);
  }
  return { w, h, px };
}

function encodePng(img: Image): Uint8Array {
  const stride = img.w * 4;
  // Filter 0 on every row: the atlas is mostly flat colour and deflate handles
  // it well enough that the smarter filters are not worth the code.
  const raw = new Uint8Array((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const z = new Uint8Array(deflateSync(Buffer.from(raw), { level: 9 }));

  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, img.w);
  idv.setUint32(4, img.h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", z),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Box-filter downsample. The atlas has no alpha-premultiplication to respect. */
function resize(img: Image, w: number, h: number): Image {
  const px = new Uint8Array(w * h * 4);
  const sx = img.w / w;
  const sy = img.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * img.w + xx) * 4;
          r += img.px[s]; g += img.px[s + 1]; b += img.px[s + 2]; a += img.px[s + 3];
          n++;
        }
      }
      const d = (y * w + x) * 4;
      px[d] = Math.round(r / n); px[d + 1] = Math.round(g / n);
      px[d + 2] = Math.round(b / n); px[d + 3] = Math.round(a / n);
    }
  }
  return { w, h, px };
}

/**
 * True where the stripe is allowed to be repainted.
 *
 * The fuselage and fin islands live in the left three-quarters of the atlas.
 * The right quarter is wings and tailplane, whose undersides are a grey in the
 * same value window as the stripe -- repainting those gives a navy-bottomed
 * wing no Cessna has ever had. The middle inset is the wheels.
 */
function inStripeRegion(u: number, v: number): boolean {
  if (u > 0.735) return false;
  if (u > 0.345 && u < 0.605 && v > 0.42 && v < 0.58) return false;
  return true;
}

function recolour(img: Image): number {
  let changed = 0;
  for (let y = 0; y < img.h; y++) {
    const v = y / img.h;
    for (let x = 0; x < img.w; x++) {
      const u = x / img.w;
      if (!inStripeRegion(u, v)) continue;
      const d = (y * img.w + x) * 4;
      if (img.px[d + 3] < 8) continue;

      const r = img.px[d] / 255;
      const g = img.px[d + 1] / 255;
      const b = img.px[d + 2] / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx <= 0) continue;
      const sat = (mx - mn) / mx;
      if (sat > S_MAX) continue;
      if (mx < V_LO || mx > V_HI) continue;

      // Keep the stripe's own shading: scale the navy by how light this pixel
      // was relative to the middle of the window, so highlights on the sweep
      // stay highlights instead of flattening to one flat block of colour.
      const k = mx / NAVY_PIVOT;
      img.px[d] = Math.round(Math.min(1, NAVY.r * k) * 255);
      img.px[d + 1] = Math.round(Math.min(1, NAVY.g * k) * 255);
      img.px[d + 2] = Math.round(Math.min(1, NAVY.b * k) * 255);
      changed++;
    }
  }
  return changed;
}

const src = decodePng(new Uint8Array(await Bun.file(SRC).arrayBuffer()));
console.log(`source     ${src.w}x${src.h}`);
const changed = recolour(src);
console.log(`repainted  ${changed} px (${((100 * changed) / (src.w * src.h)).toFixed(2)}% of the atlas)`);
const small = resize(src, OUT_W, OUT_H);
const png = encodePng(small);
await Bun.write(OUT, png);
console.log(`wrote      ${OUT}  ${small.w}x${small.h}  ${png.length} B`);
