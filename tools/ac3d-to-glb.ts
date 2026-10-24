// Converts the FlightGear Cessna 182S from AC3D (.ac) to a game-ready .glb.
//
// WHY THIS EXISTS
// The upstream model (HHS81/c182s, GPL-2.0) ships in exactly one format: AC3D
// text. Every off-the-shelf route to glTF goes through Blender, and a Blender
// install is a ~1 GB build dependency for a repo whose only other tooling is
// bun. AC3D is a small, fully-documented text format, so converting it here
// keeps the build to `bun` and keeps the conversion auditable and diffable.
//
// THE TWO THINGS A FUTURE READER WILL GET WRONG
//
// 1. AXIS CHANGE. AC3D here has nose at -X, tail at +X, up +Y, span along Z.
//    The app wants forward = -Z, up = +Y, right = +X. That is the PROPER
//    rotation (x,y,z) -> (-z, y, x), determinant +1. It is tempting to write
//    a mirror instead (e.g. swapping X and Z with no sign change, det = -1),
//    which lines the model up just as well but silently inverts every triangle
//    winding and every normal: the aircraft renders inside-out under backface
//    culling and lights from the wrong side. Do not introduce a reflection.
//    After rotating, the model is re-centred in X and Z (Y is left alone so
//    the wheels keep their natural height below y = 0).
//
// 2. CREASE-ANGLE SMOOTHING. AC3D stores no normals at all, only a per-object
//    `crease` angle (80 degrees throughout this file). Accumulating one
//    averaged normal per position index is the obvious implementation and is
//    wrong: it rounds off every hard edge, so the wing/fuselage fillet, the
//    control-surface gaps and the strut ends all turn to mush. Averaging
//    nothing (flat shading) is equally wrong and much more obviously so on a
//    fuselage. What is implemented here is the real rule: for each position
//    index, the incident faces are partitioned into smoothing clusters by
//    union-find over pairwise face-normal angle <= crease, and each cluster
//    gets its own area-weighted averaged normal and its own output vertex.
//    Faces with the SURF 0x10 smooth bit clear never join a cluster.
//
// Output vertices are additionally keyed on UV, because AC3D stores UVs
// per-face-corner: a texture seam must split the vertex even when the
// smoothing cluster does not.
//
// Run: bun tools/ac3d-to-glb.ts

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { parseAc3d, buildMesh, type BuiltMesh, type BuildStats } from "./ac3d";

const SRC_DIR = new URL("../assets-src/c182s/", import.meta.url).pathname;
const OUT_DIR = new URL("../public/aircraft/", import.meta.url).pathname;

// ------------------------------------------------------------------ filtering

const EXCLUDE_SUBSTRINGS = [
  "winterkit",
  "tiedownleft",
  "tiedownright",
  "tiedownhotspotleft",
  "tiedownhotspotright",
  "tiedownhotspottail",
  "reddragonengingepreheater",
  "reddragonenginepreheater",
  "external-power",
  "cover",
  "pitotcover",
  "chokes",
  "safety-cone",
];

const ROOT_OBJECT_NAME = "Blender_exporter_v2.26__c182s.ac";

function isExcluded(name: string): boolean {
  const n = name.toLowerCase();
  if (name === ROOT_OBJECT_NAME) return true;
  if (n.endsWith(".cs") || n.includes(".cs.")) return true;
  for (const s of EXCLUDE_SUBSTRINGS) if (n.includes(s)) return true;
  return false;
}

// ------------------------------------------------------------------ glB write

const TEXTURE_FILES: Record<string, string> = {
  "Default.png": "c182-default.png",
  "Lights.png": "c182-lights.png",
  "PropBlur.png": "c182-propblur.png",
};

interface GltfJson {
  asset: { version: string; generator: string; copyright: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: unknown[];
  meshes: unknown[];
  materials: unknown[];
  textures?: unknown[];
  images?: unknown[];
  samplers?: unknown[];
  accessors: unknown[];
  bufferViews: unknown[];
  buffers: { byteLength: number }[];
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function writeGlb(meshes: BuiltMesh[], untexturedColor: [number, number, number], outPath: string): number {
  const chunks: Uint8Array[] = [];
  let binLen = 0;
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];

  function addView(bytes: Uint8Array, target: number): number {
    const offset = binLen;
    chunks.push(bytes);
    binLen += bytes.byteLength;
    const padding = pad4(binLen) - binLen;
    if (padding > 0) {
      chunks.push(new Uint8Array(padding));
      binLen += padding;
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    return bufferViews.length - 1;
  }

  function addFloatAccessor(data: number[], comps: number, withMinMax: boolean): number {
    const arr = new Float32Array(data);
    const view = addView(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), 34962);
    const acc: Record<string, unknown> = {
      bufferView: view,
      componentType: 5126,
      count: data.length / comps,
      type: comps === 3 ? "VEC3" : "VEC2",
    };
    if (withMinMax) {
      const min = new Array<number>(comps).fill(Infinity);
      const max = new Array<number>(comps).fill(-Infinity);
      for (let i = 0; i < arr.length; i += comps) {
        for (let c = 0; c < comps; c++) {
          const val = arr[i + c];
          if (val < min[c]) min[c] = val;
          if (val > max[c]) max[c] = val;
        }
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  }

  function addIndexAccessor(data: number[], vertexCount: number): number {
    // 65535 is the primitive-restart value and is disallowed as an index, so
    // ushort is only safe while every index is <= 65534.
    const useShort = vertexCount <= 65535;
    const arr = useShort ? new Uint16Array(data) : new Uint32Array(data);
    const view = addView(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), 34963);
    accessors.push({
      bufferView: view,
      componentType: useShort ? 5123 : 5125,
      count: data.length,
      type: "SCALAR",
    });
    return accessors.length - 1;
  }

  // One material per (texture, doubleSided) pair.
  const images: unknown[] = [];
  const textures: unknown[] = [];
  const imageIndex = new Map<string, number>();
  for (const src of Object.keys(TEXTURE_FILES)) {
    imageIndex.set(src, images.length);
    images.push({ uri: TEXTURE_FILES[src] });
    textures.push({ source: images.length - 1, sampler: 0 });
  }

  const materials: unknown[] = [];
  const materialIndex = new Map<string, number>();
  function materialFor(texture: string | null, doubleSided: boolean): number {
    const key = `${texture ?? ""}|${doubleSided}`;
    const hit = materialIndex.get(key);
    if (hit !== undefined) return hit;
    const pbr: Record<string, unknown> = { metallicFactor: 0, roughnessFactor: 0.8 };
    if (texture !== null) {
      const ti = imageIndex.get(texture);
      if (ti === undefined) throw new Error(`unknown texture ${texture}`);
      pbr.baseColorTexture = { index: ti, texCoord: 0 };
    } else {
      pbr.baseColorFactor = [untexturedColor[0], untexturedColor[1], untexturedColor[2], 1];
    }
    materials.push({
      name: texture === null ? "untextured" : texture.replace(/\.png$/i, ""),
      pbrMetallicRoughness: pbr,
      doubleSided,
    });
    materialIndex.set(key, materials.length - 1);
    return materials.length - 1;
  }

  const nodes: unknown[] = [];
  const gltfMeshes: unknown[] = [];
  const childIndices: number[] = [];

  for (const m of meshes) {
    const posAcc = addFloatAccessor(m.positions, 3, true);
    const nrmAcc = addFloatAccessor(m.normals, 3, false);
    const uvAcc = addFloatAccessor(m.uvs, 2, false);
    const idxAcc = addIndexAccessor(m.indices, m.positions.length / 3);
    gltfMeshes.push({
      name: m.name,
      primitives: [
        {
          attributes: { POSITION: posAcc, NORMAL: nrmAcc, TEXCOORD_0: uvAcc },
          indices: idxAcc,
          material: materialFor(m.texture, m.doubleSided),
          mode: 4,
        },
      ],
    });
    nodes.push({
      name: m.name,
      mesh: gltfMeshes.length - 1,
      extras: { texture: m.texture, acMaterial: m.acMaterial },
    });
    childIndices.push(nodes.length - 1);
  }

  const rootIndex = nodes.length;
  nodes.push({ name: "c182", children: childIndices });

  const json: GltfJson = {
    asset: {
      version: "2.0",
      generator: "flyby-web tools/ac3d-to-glb.ts",
      copyright: "HHS81/c182s, GPL-2.0",
    },
    scene: 0,
    scenes: [{ nodes: [rootIndex] }],
    nodes,
    meshes: gltfMeshes,
    materials,
    textures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = pad4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonPadded + 8 + binLen;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonPadded);
  let o = 20 + jsonPadded;
  dv.setUint32(o, binLen, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  if (o !== total) throw new Error(`glb write mismatch: wrote ${o} of ${total}`);

  writeFileSync(outPath, out);
  return total;
}

// ------------------------------------------------------------------- textures

async function convertTextures(): Promise<void> {
  const jobs: { src: string; out: string; size: [number, number] | null }[] = [
    // Default.png is deliberately NOT emitted here. tools/recolor-livery.ts
    // owns it: it repaints the grey factory sweep navy and downsizes in the
    // same pass. Emitting it from both would mean whichever ran last won, and
    // re-running the converter would silently undo the paint job.
    { src: "Lights.png", out: "c182-lights.png", size: [512, 512] },
    { src: "PropBlur.png", out: "c182-propblur.png", size: null },
  ];
  for (const job of jobs) {
    const src = SRC_DIR + job.src;
    const dst = OUT_DIR + job.out;
    if (job.size === null) {
      writeFileSync(dst, readFileSync(src));
      continue;
    }
    // sips -z takes HEIGHT then WIDTH.
    const proc = Bun.spawn(
      ["sips", "-z", String(job.size[0]), String(job.size[1]), src, "--out", dst],
      { stdout: "ignore", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`sips failed on ${job.src}: ${await new Response(proc.stderr).text()}`);
    }
  }
}

// ----------------------------------------------------------------------- main

const { materials, objects } = parseAc3d(SRC_DIR + "c182s.ac");

for (const o of objects) {
  if (o.loc[0] !== 0 || o.loc[1] !== 0 || o.loc[2] !== 0) {
    throw new Error(`object ${o.name} has non-zero accumulated loc ${o.loc.join(",")}`);
  }
}

const stats: BuildStats = { degenerateFaces: 0, skippedLines: 0 };
const built: BuiltMesh[] = [];
const excluded: string[] = [];
const empty: string[] = [];

for (const o of objects) {
  if (isExcluded(o.name)) {
    excluded.push(o.name);
    continue;
  }
  const m = buildMesh(o, materials, stats);
  if (m === null) {
    empty.push(o.name);
    continue;
  }
  built.push(m);
}

// Re-centre in X and Z over the kept geometry only (the excluded ground
// clutter sits well off to the side and would drag the origin with it).
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
let minZ = Infinity;
let maxZ = -Infinity;
for (const m of built) {
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i];
    const y = m.positions[i + 1];
    const z = m.positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
}
const midX = (minX + maxX) / 2;
const midZ = (minZ + maxZ) / 2;
if (Math.abs(midX) > 0.05) {
  throw new Error(`span is not symmetric about x=0 (mid ${midX.toFixed(4)}); check the axis map`);
}
for (const m of built) {
  for (let i = 0; i < m.positions.length; i += 3) {
    m.positions[i] -= midX;
    m.positions[i + 2] -= midZ;
  }
}

let tris = 0;
let verts = 0;
for (const m of built) {
  tris += m.indices.length / 3;
  verts += m.positions.length / 3;
}

// The untextured material's colour comes from the AC3D MATERIAL of the first
// untextured mesh, which is the only colour information the file carries for
// those parts.
let untexturedColor: [number, number, number] = [0.8, 0.8, 0.8];
for (const m of built) {
  if (m.texture === null) {
    const mat = materials.find((x) => x.name === m.acMaterial);
    if (mat) untexturedColor = mat.rgb;
    break;
  }
}

mkdirSync(OUT_DIR, { recursive: true });
await convertTextures();
const glbBytes = writeGlb(built, untexturedColor, OUT_DIR + "c182.glb");

console.log(`objects: ${objects.length} parsed, ${built.length} kept, ${excluded.length} excluded, ${empty.length} empty`);
console.log(`excluded: ${excluded.join(", ")}`);
if (empty.length > 0) console.log(`empty:    ${empty.join(", ")}`);
console.log(`surfaces: ${stats.skippedLines} non-polygon skipped, ${stats.degenerateFaces} degenerate`);
console.log(`triangles: ${tris}   vertices: ${verts}   (source verts ${objects.reduce((a, o) => a + o.verts.length / 3, 0)})`);
console.log(
  `bbox after recentre: x ${(minX - midX).toFixed(3)}..${(maxX - midX).toFixed(3)} (span ${(maxX - minX).toFixed(3)})` +
    `  y ${minY.toFixed(3)}..${maxY.toFixed(3)} (height ${(maxY - minY).toFixed(3)})` +
    `  z ${(minZ - midZ).toFixed(3)}..${(maxZ - midZ).toFixed(3)} (length ${(maxZ - minZ).toFixed(3)})`,
);
console.log(`recentre offsets: x ${midX.toFixed(4)}  z ${midZ.toFixed(4)}`);

const sizes: [string, number][] = [
  ["c182.glb", glbBytes],
  ["c182-default.png", statSync(OUT_DIR + "c182-default.png").size],
  ["c182-lights.png", statSync(OUT_DIR + "c182-lights.png").size],
  ["c182-propblur.png", statSync(OUT_DIR + "c182-propblur.png").size],
];
let texTotal = 0;
for (const [name, size] of sizes) {
  if (name !== "c182.glb") texTotal += size;
  console.log(`${name.padEnd(20)} ${(size / 1024).toFixed(1)} KiB`);
}
console.log(`textures total: ${(texTotal / 1024 / 1024).toFixed(2)} MiB   glb: ${(glbBytes / 1024 / 1024).toFixed(2)} MiB`);
