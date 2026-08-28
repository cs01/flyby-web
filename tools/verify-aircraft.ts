// Headless gate for public/aircraft/c182.glb, produced by tools/ac3d-to-glb.ts.
//
// The glb is parsed here with a from-scratch reader rather than three.js on
// purpose: a loader that silently repairs what it reads (recomputing normals,
// clamping indices, ignoring a short BIN chunk) cannot tell you the file is
// broken, and a broken asset that loads is exactly the failure this is meant
// to catch. Everything below is checked against the raw bytes.
//
// Run: bun tools/verify-aircraft.ts

import { readFileSync, existsSync } from "node:fs";

const DIR = new URL("../public/aircraft/", import.meta.url).pathname;

const problems: string[] = [];
function check(ok: boolean, msg: string): void {
  if (!ok) problems.push(msg);
}

// ------------------------------------------------------------- 1. glb container

const bytes = new Uint8Array(readFileSync(DIR + "c182.glb"));
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

if (bytes.byteLength < 20) {
  console.error("FAIL c182.glb is too short to be a glb");
  process.exit(1);
}
check(dv.getUint32(0, true) === 0x46546c67, "bad glb magic");
check(dv.getUint32(4, true) === 2, "glb version is not 2");
check(dv.getUint32(8, true) === bytes.byteLength, "glb header length != file size");

const jsonLen = dv.getUint32(12, true);
check(dv.getUint32(16, true) === 0x4e4f534a, "first chunk is not JSON");
check(jsonLen % 4 === 0, "JSON chunk length is not 4-aligned");
check(20 + jsonLen + 8 <= bytes.byteLength, "JSON chunk overruns the file");

interface Accessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}
interface BufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
}
interface Primitive {
  attributes: Record<string, number>;
  indices: number;
  material: number;
}
interface Gltf {
  asset: { version: string };
  nodes: { name?: string; mesh?: number; children?: number[] }[];
  meshes: { name?: string; primitives: Primitive[] }[];
  accessors: Accessor[];
  bufferViews: BufferView[];
  buffers: { byteLength: number }[];
  images?: { uri?: string }[];
  materials?: unknown[];
}

let gltf: Gltf;
try {
  gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as Gltf;
} catch (err) {
  console.error(`FAIL glb JSON chunk does not parse: ${(err as Error).message}`);
  process.exit(1);
}

const binHeader = 20 + jsonLen;
check(dv.getUint32(binHeader + 4, true) === 0x004e4942, "second chunk is not BIN");
const binLen = dv.getUint32(binHeader, true);
const binStart = binHeader + 8;
check(binStart + binLen <= bytes.byteLength, "BIN chunk overruns the file");
check(
  gltf.buffers.length === 1 && gltf.buffers[0].byteLength === binLen,
  `BIN chunk length ${binLen} != buffer byteLength ${gltf.buffers[0]?.byteLength}`,
);

const bin = bytes.subarray(binStart, binStart + binLen);

// ------------------------------------------- 2. accessor / bufferView bounds

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

for (let i = 0; i < gltf.bufferViews.length; i++) {
  const bv = gltf.bufferViews[i];
  check(bv.buffer === 0, `bufferView ${i} references buffer ${bv.buffer}`);
  check(
    bv.byteOffset >= 0 && bv.byteOffset + bv.byteLength <= binLen,
    `bufferView ${i} [${bv.byteOffset}..${bv.byteOffset + bv.byteLength}) exceeds buffer of ${binLen}`,
  );
}

for (let i = 0; i < gltf.accessors.length; i++) {
  const a = gltf.accessors[i];
  const compBytes = COMPONENT_BYTES[a.componentType];
  const comps = TYPE_COMPS[a.type];
  check(compBytes !== undefined, `accessor ${i} has unknown componentType ${a.componentType}`);
  check(comps !== undefined, `accessor ${i} has unknown type ${a.type}`);
  if (compBytes === undefined || comps === undefined) continue;
  const bv = gltf.bufferViews[a.bufferView];
  check(bv !== undefined, `accessor ${i} references missing bufferView ${a.bufferView}`);
  if (!bv) continue;
  const off = a.byteOffset ?? 0;
  const need = a.count * comps * compBytes;
  check(off % compBytes === 0, `accessor ${i} byteOffset ${off} is not aligned to ${compBytes}`);
  check(a.count > 0, `accessor ${i} has count ${a.count}`);
  check(off + need <= bv.byteLength, `accessor ${i} needs ${off + need} bytes of a ${bv.byteLength}-byte bufferView`);
}

function readAccessor(i: number): Float64Array {
  const a = gltf.accessors[i];
  const bv = gltf.bufferViews[a.bufferView];
  const comps = TYPE_COMPS[a.type];
  const base = bv.byteOffset + (a.byteOffset ?? 0);
  const out = new Float64Array(a.count * comps);
  const view = new DataView(bin.buffer, bin.byteOffset + base, a.count * comps * COMPONENT_BYTES[a.componentType]);
  for (let k = 0; k < out.length; k++) {
    switch (a.componentType) {
      case 5126:
        out[k] = view.getFloat32(k * 4, true);
        break;
      case 5125:
        out[k] = view.getUint32(k * 4, true);
        break;
      case 5123:
        out[k] = view.getUint16(k * 2, true);
        break;
      case 5121:
        out[k] = view.getUint8(k);
        break;
      default:
        throw new Error(`accessor ${i}: unsupported componentType ${a.componentType}`);
    }
  }
  return out;
}

if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(`\n${problems.length} structural problem(s); cannot continue.`);
  process.exit(1);
}

// ------------------------------------------------------- 3/4. nodes and names

const nodeNames = new Set<string>();
for (const n of gltf.nodes) if (n.name) nodeNames.add(n.name);

check(gltf.nodes.length > 60, `node count ${gltf.nodes.length} is not > 60`);

const REQUIRED = [
  "Airframe", "Aileron.L", "Aileron.R", "Elevator", "Rudder", "Flap.L", "Flap.R",
  "Spinner", "SlowProp", "FastProp", "Windscreen", "WheelFairing.L", "WheelFairing.R",
  "WheelFairingNose", "MainWheel.L", "MainWheel.R", "FrontWheel", "NavLightRed",
  "NavLightGreen", "Strobe",
];
for (const name of REQUIRED) check(nodeNames.has(name), `required node "${name}" is missing`);

const FORBIDDEN_SUBSTRINGS = [".cs", "winterkit", "tiedown", "safety-cone", "chokes", "pitotcover"];
for (const name of nodeNames) {
  const lower = name.toLowerCase();
  for (const s of FORBIDDEN_SUBSTRINGS) {
    check(!lower.includes(s), `excluded object "${name}" is present (matched "${s}")`);
  }
}

// ------------------------------------------------ 5-10. geometry over all meshes

let triangles = 0;
let minX = Infinity, maxX = -Infinity;
let minY = Infinity, maxY = -Infinity;
let minZ = Infinity, maxZ = -Infinity;
let worstNormalDev = 0;
let uvTotal = 0;
let uvOutside = 0;
let nanCount = 0;
let airframeVerts = 0;
let airframeTris = 0;
let airframeSpanMin = Infinity;
let airframeSpanMax = -Infinity;
let airframeCorners = 0;
let airframeSmoothedCorners = 0;

for (const node of gltf.nodes) {
  if (node.mesh === undefined) continue;
  const mesh = gltf.meshes[node.mesh];
  for (const prim of mesh.primitives) {
    const posIdx = prim.attributes.POSITION;
    const nrmIdx = prim.attributes.NORMAL;
    const uvIdx = prim.attributes.TEXCOORD_0;
    check(posIdx !== undefined, `${node.name}: primitive has no POSITION`);
    check(nrmIdx !== undefined, `${node.name}: primitive has no NORMAL`);
    check(uvIdx !== undefined, `${node.name}: primitive has no TEXCOORD_0`);
    if (posIdx === undefined || nrmIdx === undefined || uvIdx === undefined) continue;

    const pos = readAccessor(posIdx);
    const nrm = readAccessor(nrmIdx);
    const uv = readAccessor(uvIdx);
    const idx = readAccessor(prim.indices);

    const vertexCount = gltf.accessors[posIdx].count;
    check(
      gltf.accessors[nrmIdx].count === vertexCount && gltf.accessors[uvIdx].count === vertexCount,
      `${node.name}: attribute counts disagree`,
    );
    check(idx.length % 3 === 0, `${node.name}: index count ${idx.length} is not a multiple of 3`);
    triangles += idx.length / 3;

    for (let k = 0; k < idx.length; k++) {
      if (idx[k] >= vertexCount) {
        check(false, `${node.name}: index ${idx[k]} out of range (${vertexCount} vertices)`);
        break;
      }
    }

    // 7. accessor min/max finite, and no NaN in any attribute stream.
    const acc = gltf.accessors[posIdx];
    check(
      acc.min !== undefined && acc.max !== undefined &&
        acc.min.every(Number.isFinite) && acc.max.every(Number.isFinite),
      `${node.name}: POSITION accessor lacks finite min/max`,
    );
    for (const arr of [pos, nrm, uv]) {
      for (let k = 0; k < arr.length; k++) if (!Number.isFinite(arr[k])) nanCount++;
    }

    for (let k = 0; k < pos.length; k += 3) {
      const x = pos[k], y = pos[k + 1], z = pos[k + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    // 8. unit normals.
    for (let k = 0; k < nrm.length; k += 3) {
      const len = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]);
      const dev = Math.abs(len - 1);
      if (dev > worstNormalDev) worstNormalDev = dev;
    }

    // 9. UVs inside the atlas (this atlas is not tiled).
    for (let k = 0; k < uv.length; k++) {
      uvTotal++;
      if (uv[k] < -0.01 || uv[k] > 1.01) uvOutside++;
    }

    if (node.name === "Airframe") {
      airframeVerts += vertexCount;
      airframeTris += idx.length / 3;
      for (let k = 0; k < pos.length; k += 3) {
        if (pos[k] < airframeSpanMin) airframeSpanMin = pos[k];
        if (pos[k] > airframeSpanMax) airframeSpanMax = pos[k];
      }
      // Smoothing oracle: under flat shading a vertex normal is bit-identical
      // to its own triangle's geometric normal. Any corner whose stored normal
      // has been pulled off its face normal is proof that neighbouring faces
      // were actually averaged in.
      const cosLimit = Math.cos((0.5 * Math.PI) / 180);
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
        const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
        let fx = e1y * e2z - e1z * e2y;
        let fy = e1z * e2x - e1x * e2z;
        let fz = e1x * e2y - e1y * e2x;
        const flen = Math.hypot(fx, fy, fz);
        if (!(flen > 1e-12)) continue; // degenerate triangle, no face normal
        fx /= flen; fy /= flen; fz /= flen;
        for (const v of [a, b, c]) {
          airframeCorners++;
          if (nrm[v] * fx + nrm[v + 1] * fy + nrm[v + 2] * fz < cosLimit) airframeSmoothedCorners++;
        }
      }
    }
  }
}

const span = maxX - minX;
const length = maxZ - minZ;
const height = maxY - minY;
const zCentre = (minZ + maxZ) / 2;

check(triangles >= 8000 && triangles <= 40000, `triangle count ${triangles} outside 8000..40000`);
// Upper bound is 11.2, not 11.1: the airframe span is 10.91 m (the book figure)
// but the wingtip nav-light lenses stand ~0.12 m proud of each tip, so the
// union bbox is legitimately wider. The airframe-only span below is the sharp
// oracle for "the model is in metres and was not rescaled".
check(span >= 10.8 && span <= 11.2, `span (x) ${span.toFixed(3)} outside 10.8..11.2 m`);
const airframeSpan = airframeSpanMax - airframeSpanMin;
check(
  airframeSpan >= 10.85 && airframeSpan <= 10.98,
  `Airframe span ${airframeSpan.toFixed(3)} outside 10.85..10.98 m (C182 wingspan is 10.91 m)`,
);
check(length >= 8.2 && length <= 9.0, `length (z) ${length.toFixed(3)} outside 8.2..9.0 m`);
check(height >= 2.6 && height <= 3.6, `height (y) ${height.toFixed(3)} outside 2.6..3.6 m`);
check(Math.abs(zCentre) < 0.05, `z-centre ${zCentre.toFixed(4)} is not within 0.05 of the origin`);
check(nanCount === 0, `${nanCount} non-finite values in position/normal/uv data`);
check(worstNormalDev <= 1e-3, `worst normal length deviation ${worstNormalDev.toExponential(3)} exceeds 1e-3`);
const uvOutsideFrac = uvTotal === 0 ? 1 : uvOutside / uvTotal;
check(uvOutsideFrac <= 0.005, `${uvOutside}/${uvTotal} UV components (${(uvOutsideFrac * 100).toFixed(2)}%) outside -0.01..1.01`);

// 10. Smoothing actually happened.
//
// The obvious form of this check -- "flat shading gives exactly 3 vertices per
// triangle, so assert verts < 3 * tris" -- does not work on this model and was
// measured not to: the source is quad-dominant, so even with crease smoothing
// switched off entirely the ratio only reaches 2.06 and the `< 3` bound passes
// unconditionally. A bound a broken converter still satisfies is not a gate.
// The ratio is still printed (0.71 smoothed vs 2.06 flat) and bounded well
// under the measured flat baseline, but the check that carries the weight is
// the corner-vs-face-normal fraction, which goes to ~0 under flat shading.
check(airframeTris > 0, "Airframe has no triangles");
const airframeRatio = airframeTris > 0 ? airframeVerts / airframeTris : 3;
check(airframeRatio < 1.5, `Airframe vertex:triangle ratio ${airframeRatio.toFixed(3)} is at the flat-shaded level (2.06)`);
const smoothFrac = airframeCorners === 0 ? 0 : airframeSmoothedCorners / airframeCorners;
check(
  smoothFrac > 0.5,
  `only ${(smoothFrac * 100).toFixed(1)}% of Airframe corners have a normal distinct from their face normal: not smoothed`,
);

// ------------------------------------------------------------- 11. textures

const EXPECTED_IMAGES = ["c182-default.png", "c182-lights.png", "c182-propblur.png"];
const uris = (gltf.images ?? []).map((im) => im.uri ?? "");
for (const want of EXPECTED_IMAGES) check(uris.includes(want), `glb does not reference image "${want}"`);
for (const uri of uris) {
  const path = DIR + uri;
  if (!existsSync(path)) {
    check(false, `referenced texture "${uri}" is missing from ${DIR}`);
    continue;
  }
  const png = readFileSync(path);
  check(png.byteLength > 0, `texture "${uri}" is empty`);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  check(
    png.byteLength >= 8 && sig.every((b, i) => png[i] === b),
    `texture "${uri}" does not start with the PNG signature`,
  );
}

// ---------------------------------------------------------------------- report

console.log(`nodes:      ${gltf.nodes.length} (${gltf.meshes.length} meshes, ${gltf.materials?.length ?? 0} materials)`);
console.log(`triangles:  ${triangles}`);
console.log(`bbox:       span(x) ${span.toFixed(3)} m   length(z) ${length.toFixed(3)} m   height(y) ${height.toFixed(3)} m`);
console.log(`            x ${minX.toFixed(3)}..${maxX.toFixed(3)}  y ${minY.toFixed(3)}..${maxY.toFixed(3)}  z ${minZ.toFixed(3)}..${maxZ.toFixed(3)}`);
console.log(`z-centre:   ${zCentre.toFixed(4)}`);
console.log(`airframe:   span ${airframeSpan.toFixed(3)} m, ${airframeVerts} verts / ${airframeTris} tris = ${airframeRatio.toFixed(3)} (2.06 if flat-shaded)`);
console.log(`smoothing:  ${(smoothFrac * 100).toFixed(1)}% of Airframe corners have a normal off their own face normal`);
console.log(`normals:    worst |len-1| = ${worstNormalDev.toExponential(2)}`);
console.log(`uvs:        ${uvOutside}/${uvTotal} outside -0.01..1.01 (${(uvOutsideFrac * 100).toFixed(3)}%)`);

if (problems.length > 0) {
  console.error("");
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(`\nverify-aircraft: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("verify-aircraft: OK");
