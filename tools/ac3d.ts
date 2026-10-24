// AC3D (.ac) parsing and mesh building, shared by the two FlightGear
// converters: tools/ac3d-to-glb.ts (the Cessna you fly) and
// tools/ai-aircraft.ts (the live-traffic airliners). Both need the same axis
// change and the same crease-angle smoothing; see the header of
// tools/ac3d-to-glb.ts for why each is the way it is.

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- AC3D model

export interface AcMaterial {
  name: string;
  rgb: [number, number, number];
}

export interface AcSurface {
  flags: number;
  mat: number;
  refs: { vi: number; u: number; v: number }[];
}

export interface AcObject {
  kind: string;
  name: string;
  texture: string | null;
  texrep: [number, number];
  crease: number;
  loc: [number, number, number];
  verts: number[]; // flat xyz
  surfaces: AcSurface[];
}

// ---------------------------------------------------------------- AC3D parse

/**
 * Reads the AC3D subset this model uses. The file is read as latin1 so that
 * string offsets are byte offsets, which is what makes the `data N` block
 * (N raw bytes, not a line) skippable correctly.
 */
export function parseAc3d(path: string): { materials: AcMaterial[]; objects: AcObject[] } {
  const text = readFileSync(path, "latin1");
  let pos = 0;

  function readLine(): string | null {
    if (pos >= text.length) return null;
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    let end = nl;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    const line = text.slice(pos, end);
    pos = nl + 1;
    return line;
  }

  function skipRaw(n: number): void {
    pos += n;
    if (text.charCodeAt(pos) === 13) pos++;
    if (text.charCodeAt(pos) === 10) pos++;
  }

  const header = readLine();
  if (header === null || !header.startsWith("AC3Db")) {
    throw new Error(`not an AC3D file: header ${JSON.stringify(header)}`);
  }

  const materials: AcMaterial[] = [];
  const objects: AcObject[] = [];

  function quoted(line: string): string {
    const a = line.indexOf('"');
    const b = line.lastIndexOf('"');
    if (a < 0 || b <= a) throw new Error(`expected quoted string in: ${line}`);
    return line.slice(a + 1, b);
  }

  // Returns the number of objects consumed (self + descendants).
  function parseObject(kindLine: string, parentLoc: [number, number, number]): void {
    const obj: AcObject = {
      kind: kindLine.slice("OBJECT ".length).trim(),
      name: "",
      texture: null,
      texrep: [1, 1],
      crease: 45,
      loc: [parentLoc[0], parentLoc[1], parentLoc[2]],
      verts: [],
      surfaces: [],
    };
    let kids = 0;

    for (;;) {
      const line = readLine();
      if (line === null) throw new Error(`unexpected EOF inside object ${obj.name}`);
      if (line.length === 0) continue;
      const sp = line.indexOf(" ");
      const tok = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? "" : line.slice(sp + 1);

      switch (tok) {
        case "name":
          obj.name = quoted(line);
          break;
        case "texture":
          obj.texture = quoted(line);
          break;
        case "texrep": {
          const p = rest.trim().split(/\s+/);
          obj.texrep = [Number(p[0]), Number(p[1])];
          break;
        }
        case "crease":
          obj.crease = Number(rest.trim());
          break;
        case "loc": {
          const p = rest.trim().split(/\s+/).map(Number);
          obj.loc = [obj.loc[0] + p[0], obj.loc[1] + p[1], obj.loc[2] + p[2]];
          break;
        }
        case "rot":
          // Not used by this model; a silent identity assumption would rotate
          // parts wrongly with no error, so refuse instead.
          throw new Error(`object ${obj.name}: 'rot' is not supported`);
        case "url":
        case "hidden":
        case "locked":
        case "subdiv":
          break;
        case "data":
          skipRaw(Number(rest.trim()));
          break;
        case "numvert": {
          const n = Number(rest.trim());
          obj.verts = new Array<number>(n * 3);
          for (let i = 0; i < n; i++) {
            const vl = readLine();
            if (vl === null) throw new Error("EOF in numvert");
            const p = vl.trim().split(/\s+/);
            obj.verts[i * 3] = Number(p[0]);
            obj.verts[i * 3 + 1] = Number(p[1]);
            obj.verts[i * 3 + 2] = Number(p[2]);
          }
          break;
        }
        case "numsurf": {
          const n = Number(rest.trim());
          for (let i = 0; i < n; i++) {
            obj.surfaces.push(parseSurface());
          }
          break;
        }
        case "kids":
          kids = Number(rest.trim());
          objects.push(obj);
          for (let i = 0; i < kids; i++) {
            const kl = readLine();
            // fgdata's 757-200.ac declares six kids on its world and ships
            // five. Every declared object has been read by then, so stopping
            // loses nothing; a short file anywhere else still throws.
            if (kl === null) {
              console.warn(`${path}: ${obj.name} declares ${kids} kids, file ends after ${i}`);
              return;
            }
            if (!kl.startsWith("OBJECT ")) throw new Error(`expected OBJECT, got ${kl}`);
            parseObject(kl, obj.loc);
          }
          return;
        default:
          throw new Error(`unhandled AC3D token ${JSON.stringify(tok)} in ${line}`);
      }
    }
  }

  function parseSurface(): AcSurface {
    const surf: AcSurface = { flags: 0, mat: 0, refs: [] };
    let sawRefs = false;
    while (!sawRefs) {
      const line = readLine();
      if (line === null) throw new Error("EOF in surface");
      if (line.length === 0) continue;
      const sp = line.indexOf(" ");
      const tok = sp < 0 ? line : line.slice(0, sp);
      const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
      if (tok === "SURF") {
        // Flags appear as both 0x.. and 0X.. in the wild.
        surf.flags = parseInt(rest.replace(/^0[xX]/, ""), 16);
      } else if (tok === "mat") {
        surf.mat = Number(rest);
      } else if (tok === "refs") {
        const k = Number(rest);
        for (let i = 0; i < k; i++) {
          const rl = readLine();
          if (rl === null) throw new Error("EOF in refs");
          const p = rl.trim().split(/\s+/);
          surf.refs.push({ vi: Number(p[0]), u: Number(p[1]), v: Number(p[2]) });
        }
        sawRefs = true;
      } else {
        throw new Error(`unhandled surface token ${JSON.stringify(tok)}`);
      }
    }
    return surf;
  }

  for (;;) {
    const line = readLine();
    if (line === null) break;
    if (line.length === 0) continue;
    if (line.startsWith("MATERIAL ")) {
      const name = quoted(line);
      const m = /\brgb\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
      if (!m) throw new Error(`MATERIAL without rgb: ${line}`);
      materials.push({ name, rgb: [Number(m[1]), Number(m[2]), Number(m[3])] });
    } else if (line.startsWith("OBJECT ")) {
      parseObject(line, [0, 0, 0]);
    } else {
      throw new Error(`unexpected top-level line: ${line}`);
    }
  }

  return { materials, objects };
}

// ------------------------------------------------------------------- geometry

/** Proper rotation: source (nose -X, up +Y, span Z) -> app (forward -Z, up +Y, right +X). */
export function toAppFrame(x: number, y: number, z: number): [number, number, number] {
  return [-z, y, x];
}

export interface BuiltMesh {
  name: string;
  texture: string | null;
  acMaterial: string;
  doubleSided: boolean;
  positions: number[];
  normals: number[];
  uvs: number[];
  /** Per-vertex AC3D material rgb, only when buildMesh was asked for it. */
  colors?: number[];
  indices: number[];
}

class UnionFind {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(a: number): number {
    let r = a;
    while (this.parent[r] !== r) r = this.parent[r];
    while (this.parent[a] !== r) {
      const next = this.parent[a];
      this.parent[a] = r;
      a = next;
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

const SURF_TYPE_MASK = 0x0f;
const SURF_SMOOTH = 0x10;
const SURF_TWOSIDED = 0x20;

export interface BuildStats {
  degenerateFaces: number;
  skippedLines: number;
}

/**
 * `withColors` also keys output vertices on the surface material and emits its
 * rgb per vertex. Off for the Cessna, whose output must stay byte-identical;
 * on for the AI models, which paint their untextured parts by material.
 */
export function buildMesh(
  obj: AcObject,
  materials: AcMaterial[],
  stats: BuildStats,
  withColors = false,
): BuiltMesh | null {
  const nverts = obj.verts.length / 3;
  if (nverts === 0) return null;

  // Polygons only; AC3D line and closed-line surfaces have no area.
  const faces: AcSurface[] = [];
  for (const s of obj.surfaces) {
    if ((s.flags & SURF_TYPE_MASK) !== 0) {
      stats.skippedLines++;
      continue;
    }
    if (s.refs.length < 3) {
      stats.skippedLines++;
      continue;
    }
    faces.push(s);
  }
  if (faces.length === 0) return null;

  // Face normals by Newell's method: robust for non-planar quads, and its
  // magnitude is twice the polygon area, which is exactly the weight wanted
  // for the averaged vertex normal.
  const faceN: number[] = new Array(faces.length * 3);
  const faceValid: boolean[] = new Array(faces.length);
  for (let f = 0; f < faces.length; f++) {
    const refs = faces[f].refs;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < refs.length; i++) {
      const a = refs[i].vi * 3;
      const b = refs[(i + 1) % refs.length].vi * 3;
      const ax = obj.verts[a];
      const ay = obj.verts[a + 1];
      const az = obj.verts[a + 2];
      const bx = obj.verts[b];
      const by = obj.verts[b + 1];
      const bz = obj.verts[b + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) {
      faceValid[f] = false;
      stats.degenerateFaces++;
      faceN[f * 3] = 0;
      faceN[f * 3 + 1] = 1;
      faceN[f * 3 + 2] = 0;
      continue;
    }
    faceValid[f] = true;
    // Kept unnormalised: length is the area weight.
    faceN[f * 3] = nx;
    faceN[f * 3 + 1] = ny;
    faceN[f * 3 + 2] = nz;
  }

  // Incident faces per position index.
  const incident: number[][] = new Array(nverts);
  for (let f = 0; f < faces.length; f++) {
    if (!faceValid[f]) continue;
    for (const r of faces[f].refs) {
      (incident[r.vi] ??= []).push(f);
    }
  }

  const cosCrease = Math.cos((obj.crease * Math.PI) / 180);

  // clusterOf[faceIndexWithinIncidentList] resolved lazily per position.
  // faceCluster maps (posIdx, faceIdx) -> cluster id, stored as a Map keyed by
  // face index inside a per-position array.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const vertMap = new Map<string, number>();

  // Per position: cluster representative face -> averaged+normalised normal.
  const clusterNormalCache = new Map<number, Float64Array>();
  const clusterRootCache = new Map<number, Map<number, number>>();

  function clustersFor(vi: number): Map<number, number> {
    let cached = clusterRootCache.get(vi);
    if (cached) return cached;
    const inc = incident[vi] ?? [];
    const uf = new UnionFind(inc.length);
    for (let i = 0; i < inc.length; i++) {
      const fi = inc[i];
      if ((faces[fi].flags & SURF_SMOOTH) === 0) continue;
      const ix = faceN[fi * 3];
      const iy = faceN[fi * 3 + 1];
      const iz = faceN[fi * 3 + 2];
      const il = Math.hypot(ix, iy, iz);
      for (let j = i + 1; j < inc.length; j++) {
        const fj = inc[j];
        if ((faces[fj].flags & SURF_SMOOTH) === 0) continue;
        const jx = faceN[fj * 3];
        const jy = faceN[fj * 3 + 1];
        const jz = faceN[fj * 3 + 2];
        const jl = Math.hypot(jx, jy, jz);
        const dot = (ix * jx + iy * jy + iz * jz) / (il * jl);
        if (dot >= cosCrease) uf.union(i, j);
      }
    }
    // Map face index -> a stable cluster id (the incident-list root slot).
    const map = new Map<number, number>();
    for (let i = 0; i < inc.length; i++) {
      const fi = inc[i];
      map.set(fi, (faces[fi].flags & SURF_SMOOTH) === 0 ? -1 - fi : inc[uf.find(i)]);
    }
    cached = map;
    clusterRootCache.set(vi, cached);
    return cached;
  }

  function normalFor(vi: number, fi: number): Float64Array {
    const clusters = clustersFor(vi);
    const cid = clusters.get(fi)!;
    const key = vi * 0x40000000 + (cid + 0x20000000);
    const hit = clusterNormalCache.get(key);
    if (hit) return hit;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (cid < 0) {
      nx = faceN[fi * 3];
      ny = faceN[fi * 3 + 1];
      nz = faceN[fi * 3 + 2];
    } else {
      for (const [f, c] of clusters) {
        if (c !== cid) continue;
        nx += faceN[f * 3];
        ny += faceN[f * 3 + 1];
        nz += faceN[f * 3 + 2];
      }
    }
    let len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) {
      // Cluster cancelled itself out (back-to-back faces); fall back to the
      // face's own normal so the vertex is never left with a zero normal.
      nx = faceN[fi * 3];
      ny = faceN[fi * 3 + 1];
      nz = faceN[fi * 3 + 2];
      len = Math.hypot(nx, ny, nz) || 1;
    }
    const out = new Float64Array(3);
    out[0] = nx / len;
    out[1] = ny / len;
    out[2] = nz / len;
    clusterNormalCache.set(key, out);
    return out;
  }

  let doubleSided = false;
  const matUse = new Map<number, number>();

  for (let f = 0; f < faces.length; f++) {
    if (!faceValid[f]) continue;
    const surf = faces[f];
    if ((surf.flags & SURF_TWOSIDED) !== 0) doubleSided = true;
    matUse.set(surf.mat, (matUse.get(surf.mat) ?? 0) + 1);

    const corner: number[] = [];
    for (const r of surf.refs) {
      const u = r.u * obj.texrep[0];
      // AC3D V runs bottom-up (OpenGL convention); glTF TEXCOORD_0 V runs
      // top-down, so flip. Checked against the atlas rather than assumed:
      // 33.8% of Default.png is unused black, and with this flip only 13.1%
      // of triangle centroids land on it, against 38.9% without it.
      const v = 1 - r.v * obj.texrep[1];
      const cid = clustersFor(r.vi).get(f)!;
      const key = withColors ? `${r.vi}|${cid}|${u}|${v}|${surf.mat}` : `${r.vi}|${cid}|${u}|${v}`;
      let idx = vertMap.get(key);
      if (idx === undefined) {
        const p = toAppFrame(
          obj.verts[r.vi * 3] + obj.loc[0],
          obj.verts[r.vi * 3 + 1] + obj.loc[1],
          obj.verts[r.vi * 3 + 2] + obj.loc[2],
        );
        const n = normalFor(r.vi, f);
        const nn = toAppFrame(n[0], n[1], n[2]);
        idx = positions.length / 3;
        positions.push(p[0], p[1], p[2]);
        normals.push(nn[0], nn[1], nn[2]);
        uvs.push(u, v);
        if (withColors) {
          const rgb = materials[surf.mat]?.rgb ?? [1, 1, 1];
          colors.push(rgb[0], rgb[1], rgb[2]);
        }
        vertMap.set(key, idx);
      }
      corner.push(idx);
    }
    // Fan triangulation preserves the source CCW winding, and the axis change
    // is a proper rotation, so front faces stay front faces.
    for (let i = 1; i + 1 < corner.length; i++) {
      indices.push(corner[0], corner[i], corner[i + 1]);
    }
  }

  if (indices.length === 0) return null;

  let bestMat = -1;
  let bestCount = -1;
  for (const [m, c] of matUse) {
    if (c > bestCount) {
      bestCount = c;
      bestMat = m;
    }
  }

  return {
    name: obj.name,
    texture: obj.texture,
    acMaterial: materials[bestMat]?.name ?? "",
    doubleSided,
    positions,
    normals,
    uvs,
    ...(withColors ? { colors } : {}),
    indices,
  };
}

