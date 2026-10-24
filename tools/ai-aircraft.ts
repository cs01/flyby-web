// Converts FlightGear's AI airliner models (fgdata AI/Aircraft, GPL-2.0) into
// the small glb + livery set the live-traffic layer draws.
//
// WHY THESE MODELS
// fgdata's AI collection is the one GPL source of real airliner shapes with
// real airline liveries: each type is a single AC3D mesh of 1.5k to 5k
// surfaces and ONE 1024x1024 texture atlas per livery, which is exactly the
// shape an instanced draw wants (one geometry, one texture, many aircraft).
//
// WHAT THIS EMITS, per family, into public/aircraft/traffic/:
//   <id>.glb          two meshes, "body" and "gear", no materials or images
//                     (the app supplies the shader and picks the livery)
//   <id>-<CODE>.webp  one per livery, CODE the airline's ICAO prefix, or
//                     "default" for the plain one
//   manifest.json     families, liveries and the measured dimensions the app
//                     needs (span, wheel height, nav-light positions)
//
// Vertex layout is 24 bytes: float32 position, int8 normal
// (KHR_mesh_quantization), float32 uv, uint8 rgba colour. The colour carries
// the AC3D material rgb so untextured parts (the PA-28's wings, the
// Challenger's engines) keep their paint, and alpha 0 marks them untextured.
//
// Sources are fetched once from the pinned fgdata commit into
// assets-src/fgdata-ai/ (kept in the repo as the GPL preferred form) and
// converted from there. Run: bun tools/ai-aircraft.ts

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseAc3d, buildMesh, type BuiltMesh, type BuildStats } from "./ac3d";

const FGDATA_SHA = "624f6be5f09ac5b1727d4e03c17c8f327aaa41fc";
const RAW = `https://gitlab.com/flightgear/fgdata/-/raw/${FGDATA_SHA}/AI/Aircraft/`;
const SRC = new URL("../assets-src/fgdata-ai/", import.meta.url).pathname;
const OUT = new URL("../public/aircraft/traffic/", import.meta.url).pathname;

/** Upstream livery directory name -> the ICAO airline prefix that wears it. */
const LIVERY_CODE: Record<string, string> = {
  Default: "default",
  Delta: "DAL",
  UnitedAirlines: "UAL",
  United: "UAL",
  American: "AAL",
  AmericanAirlines: "AAL",
  AmericanEagle: "AAL",
  JetBlue: "JBU",
  AlaskaAirlines: "ASA",
  AirCanada: "ACA",
  BritishAirways: "BAW",
  Hawaiian: "HAL",
  Westjet: "WJA",
  CopaAirlines: "CMP",
  VirginAtlantic: "VIR",
  AirFrance: "AFR",
  Emirates: "UAE",
  AerLingus: "EIN",
  Turkish: "THY",
  Lufthansa: "DLH",
  Qatar: "QTR",
  FedEx: "FDX",
  UPS: "UPS",
};

interface Family {
  id: string;
  /** Directory under AI/Aircraft. */
  dir: string;
  model: string;
  /** Texture file name inside Textures/<livery>/. */
  tex: string;
  liveries: string[];
  /** Upstream author, from the family's <author> in fgdata. */
  author: string;
  /** SGI .rgb textures are converted to png on fetch. */
  rgb?: boolean;
}

// The set covers the types that fill the sky over New York, San Francisco and
// Chicago (a 141-aircraft sample over NYC on 2026-10-24 was 45% A320 family,
// 737 and E175/CRJ), plus one GA single and one business jet as fallbacks.
// Liveries are the carriers that fly those types into those airports. Every
// livery is a separate lazy fetch, so a long list costs repo bytes, not
// session bytes.
const FAMILIES: Family[] = [
  { id: "a320", dir: "A320", model: "A320.ac", tex: "A320-tex.png", author: "Brett Harrison",
    liveries: ["Default", "Delta", "UnitedAirlines", "American", "JetBlue", "AlaskaAirlines", "AirCanada", "BritishAirways"] },
  { id: "a321", dir: "A321", model: "A321.ac", tex: "A321-tex.png", author: "Brett Harrison",
    liveries: ["Default", "Delta", "American", "JetBlue", "AlaskaAirlines", "Hawaiian"] },
  { id: "b738", dir: "738", model: "737-800.ac", tex: "738-tex.png", author: "Brett Harrison",
    liveries: ["Default", "Delta", "UnitedAirlines", "AmericanAirlines", "AlaskaAirlines", "Westjet", "CopaAirlines"] },
  { id: "b789", dir: "787", model: "789.ac", tex: "789-tex.png", author: "Ian (Yves) Tolosa",
    liveries: ["Default", "UnitedAirlines", "American", "BritishAirways", "VirginAtlantic"] },
  { id: "b77w", dir: "777", model: "77W.ac", tex: "77W-tex.png", author: "Ian (Yves) Tolosa",
    liveries: ["Default", "UnitedAirlines", "American", "BritishAirways", "AirFrance", "Emirates"] },
  { id: "a333", dir: "A333", model: "A333.ac", tex: "A333-tex.png", author: "Innis Cunningham, Brett Harrison",
    liveries: ["Default", "Delta", "AerLingus", "Turkish"] },
  { id: "a359", dir: "A350", model: "359.ac", tex: "359-tex.png", author: "Ian (Yves) Tolosa",
    liveries: ["Default", "Delta", "Lufthansa", "Qatar"] },
  { id: "b763", dir: "767", model: "763.ac", tex: "763-tex.png", author: "Ian (Yves) Tolosa",
    liveries: ["Default", "Delta", "UnitedAirlines"] },
  { id: "b752", dir: "757", model: "757-200.ac", tex: "757-200-tex.png", author: "unknown, modified by Brett Harrison",
    liveries: ["Default", "Delta", "UnitedAirlines", "American", "FedEx", "UPS"] },
  { id: "e175", dir: "E70", model: "ERJ175.ac", tex: "ERJ175-tex.png", author: "Ian (Yves) Tolosa",
    liveries: ["Default", "Delta", "United", "American", "AlaskaAirlines"] },
  { id: "crj7", dir: "CR7", model: "CR7.ac", tex: "CR7-tex.png", author: "Ian (Yves) Tolosa",
    liveries: ["Default", "American", "Delta", "United"] },
  { id: "e145", dir: "ERJ145", model: "ERJ-145.ac", tex: "145-map.png", author: "Brett Harrison",
    liveries: ["Default", "United", "AmericanEagle"] },
  { id: "dh8d", dir: "DH4", model: "DH4.ac", tex: "DH4-tex.png", author: "Ian Tolosa",
    liveries: ["Default", "AlaskaAirlines"] },
  { id: "pa28", dir: "pa-28", model: "pa-28.ac", tex: "28-fus.png", author: "David Megginson, Brett Harrison",
    liveries: ["Default"] },
  { id: "cl60", dir: "Bombardier-Challenger", model: "chal604.ac", tex: "chal604.rgb", author: "Chuck Dome, Innis Cunningham",
    liveries: ["Default"], rgb: true },
];

/** Light geometry, prop discs and light cones: the app draws its own lights. */
const EXCLUDE = /light|beacon|becon|strobe|blur|propdisc|cone|switch|shadow/i;
const GEAR = /gear|wheel|tyre|tire|strut|oleo/i;

async function fetchTo(rel: string): Promise<string> {
  const dst = SRC + rel;
  if (existsSync(dst)) return dst;
  mkdirSync(dirname(dst), { recursive: true });
  const res = await fetch(RAW + rel);
  if (!res.ok) throw new Error(`fetch ${rel}: ${res.status}`);
  writeFileSync(dst, new Uint8Array(await res.arrayBuffer()));
  return dst;
}

async function run(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${await new Response(p.stderr).text()}`);
}

interface Part {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  textured: number[];
  indices: number[];
}

function emptyPart(): Part {
  return { positions: [], normals: [], uvs: [], colors: [], textured: [], indices: [] };
}

function append(into: Part, m: BuiltMesh): void {
  const base = into.positions.length / 3;
  into.positions.push(...m.positions);
  into.normals.push(...m.normals);
  into.uvs.push(...m.uvs);
  const c = m.colors ?? [];
  into.colors.push(...c);
  for (let i = 0; i < m.positions.length / 3; i++) into.textured.push(m.texture ? 1 : 0);
  for (const i of m.indices) into.indices.push(i + base);
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function writeGlb(parts: [string, Part][], outPath: string, copyright: string): number {
  const chunks: Uint8Array[] = [];
  let binLen = 0;
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const view = (bytes: Uint8Array, target: number): number => {
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.byteLength, target });
    binLen += bytes.byteLength;
    const pad = pad4(binLen) - binLen;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      binLen += pad;
    }
    return bufferViews.length - 1;
  };
  const acc = (a: Record<string, unknown>): number => {
    accessors.push(a);
    return accessors.length - 1;
  };
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  for (const [name, p] of parts) {
    const n = p.positions.length / 3;
    if (n === 0) continue;
    if (n > 65534) throw new Error(`${name}: ${n} vertices does not fit a ushort index`);
    const pos = new Float32Array(p.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i++) {
      min[i % 3] = Math.min(min[i % 3], pos[i]);
      max[i % 3] = Math.max(max[i % 3], pos[i]);
    }
    // int8 normals padded to 4 bytes per vertex, as glTF requires of a vertex
    // attribute's stride.
    const nrm = new Int8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) nrm[i * 4 + k] = Math.round(Math.max(-1, Math.min(1, p.normals[i * 3 + k])) * 127);
    }
    const col = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) col[i * 4 + k] = Math.round(Math.max(0, Math.min(1, p.colors[i * 3 + k] ?? 1)) * 255);
      col[i * 4 + 3] = p.textured[i] ? 255 : 0;
    }
    const posAcc = acc({ bufferView: view(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: n, type: "VEC3", min, max });
    const nrmView = view(new Uint8Array(nrm.buffer), 34962);
    (bufferViews[nrmView] as Record<string, unknown>).byteStride = 4;
    const nrmAcc = acc({ bufferView: nrmView, componentType: 5120, normalized: true, count: n, type: "VEC3" });
    const uvAcc = acc({ bufferView: view(new Uint8Array(new Float32Array(p.uvs).buffer), 34962), componentType: 5126, count: n, type: "VEC2" });
    const colAcc = acc({ bufferView: view(col, 34962), componentType: 5121, normalized: true, count: n, type: "VEC4" });
    const idxAcc = acc({ bufferView: view(new Uint8Array(new Uint16Array(p.indices).buffer), 34963), componentType: 5123, count: p.indices.length, type: "SCALAR" });
    meshes.push({
      name,
      primitives: [{ attributes: { POSITION: posAcc, NORMAL: nrmAcc, TEXCOORD_0: uvAcc, COLOR_0: colAcc }, indices: idxAcc, mode: 4 }],
    });
    nodes.push({ name, mesh: meshes.length - 1 });
  }
  const json = {
    asset: { version: "2.0", generator: "flyby-web tools/ai-aircraft.ts", copyright },
    extensionsUsed: ["KHR_mesh_quantization"],
    extensionsRequired: ["KHR_mesh_quantization"],
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = pad4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonPadded + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonPadded);
  let o = 20 + jsonPadded;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  writeFileSync(outPath, out);
  return total;
}

export interface FamilyInfo {
  liveries: string[];
  /** Wingtip to wingtip, metres. */
  span: number;
  length: number;
  /** Lowest point of the gear, model y: the ground contact. */
  wheelY: number;
  /** Lowest point of the body with the gear up. */
  bellyY: number;
  /** Right wingtip (x > 0) and the aft-most point, for the nav lights. */
  wingtip: [number, number, number];
  tail: [number, number, number];
  /** Top of the fin, for the beacon. */
  fin: [number, number, number];
  triangles: number;
}

mkdirSync(OUT, { recursive: true });
const manifest: Record<string, FamilyInfo> = {};
let bytes = 0;

for (const f of FAMILIES) {
  const acPath = await fetchTo(`${f.dir}/Models/${f.model}`);
  const { materials, objects } = parseAc3d(acPath);
  const stats: BuildStats = { degenerateFaces: 0, skippedLines: 0 };
  const body = emptyPart();
  const gear = emptyPart();
  const kept: string[] = [];
  for (const o of objects) {
    if (o.verts.length === 0 || EXCLUDE.test(o.name)) continue;
    const m = buildMesh(o, materials, stats, true);
    if (!m) continue;
    kept.push(o.name);
    append(GEAR.test(o.name) ? gear : body, m);
  }

  // Bounds and re-centre in x/z over the body. y is left alone so the wheel
  // height below the origin is the model's own.
  const bb = (p: Part) => {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.positions.length; i++) {
      mn[i % 3] = Math.min(mn[i % 3], p.positions[i]);
      mx[i % 3] = Math.max(mx[i % 3], p.positions[i]);
    }
    return { mn, mx };
  };
  const b = bb(body);
  const midX = (b.mn[0] + b.mx[0]) / 2;
  const midZ = (b.mn[2] + b.mx[2]) / 2;
  if (Math.abs(midX) > 0.3) throw new Error(`${f.id}: span not symmetric about x=0 (mid ${midX.toFixed(3)})`);
  for (const p of [body, gear]) {
    for (let i = 0; i < p.positions.length; i += 3) {
      p.positions[i] -= midX;
      p.positions[i + 2] -= midZ;
    }
  }
  const span = b.mx[0] - b.mn[0];
  const length = b.mx[2] - b.mn[2];
  // Nose must be at -z. The fin is aft, so the highest vertex has to sit in the
  // rear half; a model that came in backwards would fly tail first.
  let fin: [number, number, number] = [0, -Infinity, 0];
  let tip: [number, number, number] = [-Infinity, 0, 0];
  let tail: [number, number, number] = [0, 0, -Infinity];
  for (let i = 0; i < body.positions.length; i += 3) {
    const x = body.positions[i], y = body.positions[i + 1], z = body.positions[i + 2];
    if (y > fin[1]) fin = [x, y, z];
    if (x > tip[0]) tip = [x, y, z];
    if (z > tail[2] && Math.abs(x) < 0.5) tail = [x, y, z];
  }
  if (fin[2] < 0) throw new Error(`${f.id}: fin top at z=${fin[2].toFixed(2)} is forward of centre; check the axis map`);
  const g = gear.positions.length ? bb(gear) : b;
  const tris = (body.indices.length + gear.indices.length) / 3;

  const glb = writeGlb([["body", body], ["gear", gear]], `${OUT}${f.id}.glb`, `FlightGear fgdata AI/Aircraft/${f.dir} (${f.author}), GPL-2.0`);
  bytes += glb;

  const codes: string[] = [];
  for (const liv of f.liveries) {
    const code = LIVERY_CODE[liv];
    if (!code) throw new Error(`${f.id}: no ICAO code for livery ${liv}`);
    let src = await fetchTo(`${f.dir}/Textures/${liv}/${f.tex}`);
    if (f.rgb) {
      const png = src.replace(/\.rgb$/, ".png");
      if (!existsSync(png)) await run(["sips", "-s", "format", "png", src, "--out", png]);
      src = png;
    }
    const out = `${OUT}${f.id}-${code}.webp`;
    // q72 at the source's own 1024: a tail logo still reads from a drone 100 m
    // off the runway, and the median livery comes out near 60 KB against
    // 230 KB for the upstream png.
    await run(["cwebp", "-quiet", "-q", "72", "-m", "6", "-resize", "1024", "0", src, "-o", out]);
    bytes += statSync(out).size;
    codes.push(code);
  }
  manifest[f.id] = {
    liveries: codes,
    span: +span.toFixed(2),
    length: +length.toFixed(2),
    wheelY: +g.mn[1].toFixed(2),
    bellyY: +b.mn[1].toFixed(2),
    wingtip: tip.map((v) => +v.toFixed(2)) as [number, number, number],
    tail: tail.map((v) => +v.toFixed(2)) as [number, number, number],
    fin: fin.map((v) => +v.toFixed(2)) as [number, number, number],
    triangles: tris,
  };
  console.log(
    `${f.id.padEnd(5)} ${tris.toString().padStart(5)} tris  span ${span.toFixed(1)} m  length ${length.toFixed(1)} m  ` +
      `wheel ${g.mn[1].toFixed(2)}  glb ${(glb / 1024).toFixed(0)} KiB  kept ${kept.join(",")}`,
  );
}

writeFileSync(`${OUT}manifest.json`, JSON.stringify(manifest, null, 1) + "\n");
console.log(`total ${(bytes / 1024 / 1024).toFixed(2)} MiB in ${OUT}`);
