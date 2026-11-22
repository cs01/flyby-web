// Museum scans of real statues, cut down to something a phone can load.
//
// The statues built in code (src/render/statues.ts) never got past lumpy
// clay; these are photogrammetry and laser scans of the actual pieces, from
// Oliver Laric's threedscans.com archive (see public/statues/CREDITS.md for
// each piece and its holding museum). A scan is millions of triangles; this
// simplifies it to a few tens of thousands, stands it upright on its base
// with its height in metres, and bakes a cavity term per vertex so folds and
// hollows stay dark without the app tracing rays.
//
//   bun tools/bake-statue-scans.ts <dir with the unzipped scans> [--only name]
//
// Output, one file per statue, public/statues/<name>.bin, little endian:
//   u32 magic "STAT", u32 vertex count, u32 index count, f32 height (m),
//   i16 x, y, z per vertex (metres * 32767 / height; y up from the base),
//   i8 nx, ny, nz and u8 cavity (0 deep hollow .. 255 open) per vertex,
//   u16 indices.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeshoptSimplifier } from "meshoptimizer";

interface Scan {
  name: string;
  /** Path under the source directory. */
  file: string;
  /** Which source axis points up, and its sign. */
  up: "+y" | "-y" | "+z" | "-z" | "+x" | "-x" | "plinth";
  /** Turn about the vertical after standing it up, degrees, so the figure faces +z. */
  yawDeg: number;
  /** The piece's real height, metres. */
  heightM: number;
  triangles: number;
  /** The source winds its triangles inward. */
  flip?: boolean;
}

const SCANS: Scan[] = [
  { name: "arringatore", file: "Portrait_Statue_Of_-Aule_Meteli/Portrait_Statue_Of_-Aule_Meteli.obj", up: "-z", yawDeg: 0, heightM: 1.79, triangles: 30000 },
  { name: "idolino", file: "Ephebe/Ephebe.obj", up: "plinth", yawDeg: -90, heightM: 1.48, triangles: 26000 },
  { name: "spinario", file: "Thorne/Thorne.obj", up: "+y", yawDeg: 180, heightM: 0.73, triangles: 22000 },
  { name: "herm", file: "Plato/Plato.obj", up: "+y", yawDeg: 180, heightM: 0.55, triangles: 12000 },
  { name: "centaur", file: "Centaur/Centaur.stl", up: "+y", yawDeg: 180, heightM: 1.1, triangles: 26000, flip: true },
  { name: "boydog", file: "enfant_au_chien_threedscans/enfant_au_chien_threedscans.obj", up: "+z", yawDeg: 0, heightM: 0.75, triangles: 20000 },
];

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function parseObj(path: string): { pos: Float32Array; idx: Uint32Array } {
  const buf = readFileSync(path);
  const pos: number[] = [], idx: number[] = [];
  let i = 0;
  const n = buf.length;
  const num = (): number => {
    while (i < n && buf[i] === 32) i++;
    const s = i;
    while (i < n && buf[i] !== 32 && buf[i] !== 10 && buf[i] !== 13) i++;
    return Number(buf.toString("latin1", s, i));
  };
  while (i < n) {
    const c = buf[i], d = buf[i + 1];
    if (c === 118 && d === 32) { // "v "
      i += 2;
      pos.push(num(), num(), num());
    } else if (c === 102 && d === 32) { // "f "
      i += 2;
      const f: number[] = [];
      while (i < n && buf[i] !== 10 && buf[i] !== 13) {
        while (i < n && buf[i] === 32) i++;
        if (buf[i] === 10 || buf[i] === 13) break;
        const s = i;
        while (i < n && buf[i] !== 32 && buf[i] !== 10 && buf[i] !== 13 && buf[i] !== 47) i++;
        const v = Number(buf.toString("latin1", s, i));
        f.push(v < 0 ? pos.length / 3 + v : v - 1);
        while (i < n && buf[i] !== 32 && buf[i] !== 10 && buf[i] !== 13) i++;
      }
      for (let k = 2; k < f.length; k++) idx.push(f[0], f[k - 1], f[k]);
    }
    while (i < n && buf[i] !== 10) i++;
    i++;
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

function parseStl(path: string): { pos: Float32Array; idx: Uint32Array } {
  const buf = readFileSync(path);
  const nt = buf.readUInt32LE(80);
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 3; k++) {
      const x = buf.readFloatLE(o + k * 12), y = buf.readFloatLE(o + k * 12 + 4), z = buf.readFloatLE(o + k * 12 + 8);
      const key = `${x},${y},${z}`;
      let v = map.get(key);
      if (v === undefined) { v = pos.length / 3; map.set(key, v); pos.push(x, y, z); }
      idx[t * 3 + k] = v;
    }
  }
  return { pos: new Float32Array(pos), idx };
}

/** Source coordinates to y-up with the given yaw; right-handedness kept so the winding stays outward. */
function orient(p: Float32Array, up: Scan["up"], yawDeg: number): void {
  const c = Math.cos((yawDeg * Math.PI) / 180), s = Math.sin((yawDeg * Math.PI) / 180);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    let X = x, Y = y, Z = z;
    if (up === "-y") { X = -x; Y = -y; }
    else if (up === "+z") { Y = z; Z = -y; }
    else if (up === "-z") { Y = -z; Z = y; }
    else if (up === "+x") { X = -y; Y = x; }
    else if (up === "-x") { X = y; Y = -x; }
    p[i] = X * c + Z * s; p[i + 1] = Y; p[i + 2] = -X * s + Z * c;
  }
}

/**
 * Stand a scan upright by its plinth. Some scans are not axis aligned (the
 * Idolino leans some 25 degrees in its file); the slab the figure stands on
 * is the largest flat area of the mesh, so the direction most of the
 * surface area faces, give or take a few degrees, is the vertical.
 */
function levelOnPlinth(p: Float32Array, idx: Uint32Array): void {
  const B = 24, bins = new Float64Array(B * B * 2 * 4);
  const tri = (t: number): [number, number, number, number, number, number, number] => {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return [nx, ny, nz, (p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3, Math.hypot(nx, ny, nz)];
  };
  const bin = (nx: number, ny: number, nz: number): number => {
    // Octahedral-ish bins: which hemisphere of z, then x and y.
    const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
    const u = Math.min(B - 1, Math.floor(((nx / l) * 0.5 + 0.5) * B)), v = Math.min(B - 1, Math.floor(((ny / l) * 0.5 + 0.5) * B));
    return ((nz < 0 ? 1 : 0) * B * B + v * B + u) * 4;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const [nx, ny, nz, , , , area] = tri(t);
    if (area === 0) continue;
    const k = bin(nx / area, ny / area, nz / area);
    bins[k] += nx; bins[k + 1] += ny; bins[k + 2] += nz; bins[k + 3] += area;
  }
  let best = 0;
  for (let k = 0; k < bins.length; k += 4) if (bins[k + 3] > bins[best + 3]) best = k;
  let ax = bins[best], ay = bins[best + 1], az = bins[best + 2];
  let l = Math.hypot(ax, ay, az); ax /= l; ay /= l; az /= l;
  // Refine over every face within 8 degrees of it, and find where that flat area lies.
  let sx = 0, sy = 0, sz = 0, cx = 0, cy = 0, cz = 0, cw = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [nx, ny, nz, mx, my, mz, area] = tri(t);
    if (area === 0 || (nx * ax + ny * ay + nz * az) / area < 0.99) continue;
    sx += nx; sy += ny; sz += nz; cx += mx * area; cy += my * area; cz += mz * area; cw += area;
  }
  l = Math.hypot(sx, sy, sz); ax = sx / l; ay = sy / l; az = sz / l; cx /= cw; cy /= cw; cz /= cw;
  // Up is the side of that flat the rest of the figure is on.
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < p.length; i += 3) { gx += p[i]; gy += p[i + 1]; gz += p[i + 2]; }
  const n = p.length / 3;
  if ((gx / n - cx) * ax + (gy / n - cy) * ay + (gz / n - cz) * az < 0) { ax = -ax; ay = -ay; az = -az; }
  // A right-handed frame with that up as y.
  let tx = Math.abs(ay) < 0.9 ? 0 : 1, ty = Math.abs(ay) < 0.9 ? 1 : 0, tz = 0;
  let bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax;
  l = Math.hypot(bx, by, bz); bx /= l; by /= l; bz /= l;
  tx = ay * bz - az * by; ty = az * bx - ax * bz; tz = ax * by - ay * bx;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    p[i] = x * tx + y * ty + z * tz; p[i + 1] = x * ax + y * ay + z * az; p[i + 2] = x * bx + y * by + z * bz;
  }
}

async function bake(src: string, sc: Scan, outDir: string): Promise<void> {
  const path = join(src, sc.file);
  const t0 = performance.now();
  const raw = sc.file.toLowerCase().endsWith(".stl") ? parseStl(path) : parseObj(path);
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.pos.length; i += 3) for (let k = 0; k < 3; k++) {
    box[k] = Math.min(box[k], raw.pos[i + k]); box[3 + k] = Math.max(box[3 + k], raw.pos[i + k]);
  }
  console.log(`${sc.name}: ${raw.pos.length / 3} vertices, ${raw.idx.length / 3} triangles, source extent ${(box[3] - box[0]).toFixed(1)} x ${(box[4] - box[1]).toFixed(1)} x ${(box[5] - box[2]).toFixed(1)}`);
  if (sc.up === "plinth") { levelOnPlinth(raw.pos, raw.idx); orient(raw.pos, "+y", sc.yawDeg); }
  else orient(raw.pos, sc.up, sc.yawDeg);
  if (sc.flip) for (let t = 0; t < raw.idx.length; t += 3) { const a = raw.idx[t + 1]; raw.idx[t + 1] = raw.idx[t + 2]; raw.idx[t + 2] = a; }

  const [simp] = MeshoptSimplifier.simplify(raw.idx, raw.pos, 3, sc.triangles * 3, 0.02);
  // Compact to the vertices the simplified mesh still uses.
  const remap = new Int32Array(raw.pos.length / 3).fill(-1);
  const pos: number[] = [];
  const idx = new Uint32Array(simp.length);
  for (let i = 0; i < simp.length; i++) {
    const v = simp[i];
    if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(raw.pos[v * 3], raw.pos[v * 3 + 1], raw.pos[v * 3 + 2]); }
    idx[i] = remap[v];
  }
  const nv = pos.length / 3;
  if (nv > 65535) throw new Error(`${sc.name}: ${nv} vertices do not fit 16-bit indices, lower its triangle target`);

  // Stand it on y = 0, centred in plan, scaled to its real height.
  let y0 = Infinity, y1 = -Infinity, cx = 0, cz = 0;
  for (let i = 0; i < nv; i++) { y0 = Math.min(y0, pos[i * 3 + 1]); y1 = Math.max(y1, pos[i * 3 + 1]); }
  // Centre on the footprint of the lowest tenth: a raised arm should not pull the figure off its base.
  let cn = 0;
  for (let i = 0; i < nv; i++) if (pos[i * 3 + 1] < y0 + (y1 - y0) * 0.1) { cx += pos[i * 3]; cz += pos[i * 3 + 2]; cn++; }
  cx /= cn; cz /= cn;
  const k = sc.heightM / (y1 - y0);
  for (let i = 0; i < nv; i++) { pos[i * 3] = (pos[i * 3] - cx) * k; pos[i * 3 + 1] = (pos[i * 3 + 1] - y0) * k; pos[i * 3 + 2] = (pos[i * 3 + 2] - cz) * k; }

  // Area-weighted normals, and the neighbours of each vertex for the cavity term.
  const nrm = new Float32Array(nv * 3);
  const nb: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz; }
    nb[a].push(b, c); nb[b].push(a, c); nb[c].push(a, b);
  }
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
    nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
  }
  // Cavity: how far the neighbours stand proud of the vertex along its
  // normal, relative to their distance, smoothed over a few rings so it
  // follows a fold rather than the triangulation.
  let cav = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    let s = 0, w = 0;
    for (const j of nb[i]) {
      const dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      s += (dx * nrm[i * 3] + dy * nrm[i * 3 + 1] + dz * nrm[i * 3 + 2]) / d; w++;
    }
    cav[i] = w ? s / w : 0;
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      let s = cav[i] * 2, w = 2;
      for (const j of nb[i]) { s += cav[j]; w++; }
      next[i] = s / w;
    }
    cav = next;
  }

  const out = Buffer.alloc(16 + nv * 10 + idx.length * 2);
  out.write("STAT", 0, "latin1");
  out.writeUInt32LE(nv, 4); out.writeUInt32LE(idx.length, 8); out.writeFloatLE(sc.heightM, 12);
  let o = 16;
  const q = 32767 / sc.heightM;
  for (let i = 0; i < nv; i++) {
    for (let c = 0; c < 3; c++) { out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pos[i * 3 + c] * q))), o); o += 2; }
  }
  for (let i = 0; i < nv; i++) {
    for (let c = 0; c < 3; c++) out.writeInt8(Math.round(nrm[i * 3 + c] * 127), o++);
    // 0.35 of concavity is a deep fold; convex and flat are fully open.
    out.writeUInt8(Math.round(255 * Math.max(0, Math.min(1, 1 - cav[i] / 0.35))), o++);
  }
  for (let i = 0; i < idx.length; i++) { out.writeUInt16LE(idx[i], o); o += 2; }
  writeFileSync(join(outDir, `${sc.name}.bin`), out);
  console.log(`  -> ${sc.name}.bin  ${nv} vertices, ${idx.length / 3} triangles, ${(out.length / 1024).toFixed(0)} KB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

const src = process.argv[2];
if (!src || !statSync(src).isDirectory()) throw new Error("usage: bun tools/bake-statue-scans.ts <dir with the unzipped scans> [--only name]");
void readdirSync;
const outDir = new URL("../public/statues/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
await MeshoptSimplifier.ready;
const only = arg("only");
for (const sc of SCANS) if (!only || only.split(",").includes(sc.name)) await bake(src, sc, outDir);
