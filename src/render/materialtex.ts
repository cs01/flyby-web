// Loads the baked material strips (public/materials, see tools/bake-materials.ts)
// into three 2D texture arrays and hands back the per-layer numbers the shader
// needs to use them.
//
// ONE load per page, shared by every Buildings instance: a live-streamed city
// builds a Buildings per tile, and each of them downloading 3 MB of brick would
// be the leak this module exists not to have. The textures are never disposed
// for the same reason; they are the size of one photograph and live as long as
// the page.
//
// The buildings render before this resolves (uMatReady stays 0 and the shader
// keeps its flat albedo), so a slow connection costs the photographs, not the
// city.

import * as THREE from "three";
import { MAT_COUNT, MAT_RES_FULL, MAT_RES_REDUCED, type MaterialManifest } from "./materials";

export interface MaterialTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  rh: THREE.DataArrayTexture;
  /** Per layer: 1 / tile width, 1 / tile height (per metre), lattice x, lattice y. */
  info: THREE.Vector4[];
  /** Per layer: the albedo layer's mean, linear. The shader divides by it. */
  mean: THREE.Vector3[];
  res: number;
}

const loads = new Map<number, Promise<MaterialTextures | null>>();

async function decodeStrip(url: string, res: number): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await (await fetch(url)).blob();
  // No colour management and no premultiply: these are data (a normal map is
  // not a picture), and a browser that converted the albedo through a display
  // profile would shift every wall's hue before the shader ever saw it.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const h = res * MAT_COUNT;
  if (bmp.width !== res || bmp.height !== h) throw new Error(`${url}: ${bmp.width}x${bmp.height}, want ${res}x${h}`);
  const canvas = new OffscreenCanvas(res, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return new Uint8Array(ctx.getImageData(0, 0, res, h).data.buffer);
}

function arrayTexture(data: Uint8Array<ArrayBuffer>, res: number, srgb: boolean, anisotropy: number): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, res, res, MAT_COUNT);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // Trilinear with mips, and anisotropic: a wall seen along a street is the
  // grazing case anisotropy exists for, and without mips a brick course at
  // 300 m is a moire, which is the shimmer the aliasing gate measures.
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  // The albedo is decoded by the sampler so mips average LIGHT, not gamma
  // codes. The normal and roughness strips are linear data.
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The material arrays for a tier. Resolves to null (and logs) on any failure,
 * so the caller's only branch is "photographs or flat".
 */
export function loadMaterialTextures(reduced: boolean, anisotropy: number): Promise<MaterialTextures | null> {
  const res = reduced ? MAT_RES_REDUCED : MAT_RES_FULL;
  let p = loads.get(res);
  if (p) return p;
  p = (async (): Promise<MaterialTextures | null> => {
    try {
      const base = `${import.meta.env.BASE_URL}materials/`;
      const manifest = (await (await fetch(`${base}manifest.json`)).json()) as MaterialManifest;
      if (manifest.entries.length !== MAT_COUNT) throw new Error(`manifest has ${manifest.entries.length} layers`);
      const [a, n, r] = await Promise.all([
        decodeStrip(`${base}albedo-${res}.jpg`, res),
        decodeStrip(`${base}normal-${res}.jpg`, res),
        decodeStrip(`${base}rh-${res}.jpg`, res),
      ]);
      return {
        albedo: arrayTexture(a, res, true, anisotropy),
        normal: arrayTexture(n, res, false, anisotropy),
        rh: arrayTexture(r, res, false, anisotropy),
        info: manifest.entries.map((e) => new THREE.Vector4(1 / e.tileM[0], 1 / e.tileM[1], e.period[0], e.period[1])),
        mean: manifest.entries.map((e) => new THREE.Vector3(e.mean[0], e.mean[1], e.mean[2])),
        res,
      };
    } catch (err) {
      console.warn("building materials unavailable, facades stay flat:", err);
      return null;
    }
  })();
  loads.set(res, p);
  return p;
}
