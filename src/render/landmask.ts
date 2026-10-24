// The landcover coverage grids as GPU textures, near field and far field.
//
// Split from src/data/landmask.ts for the same reason citypack-load.ts is split
// from citypack.ts: everything that touches THREE lives on this side, so the
// packing maths stays runnable under Bun as the gate's oracle.

import * as THREE from "three";
import { buildLandMaskRGBA, encodeShoreDistance, shoreDistanceM } from "../data/landmask";
import type { LandLevel, LandPack } from "../data/landcover";

/**
 * Where the 8-bit shore distance saturates, per level. The near level covers
 * the river-to-bay range a fetch argument needs (a bay's middle is a few km
 * from any coast); the far level only has to tell a bay from an ocean.
 * Mirrored as literals in the terrain shader's decode.
 */
export const SHORE_MAX_NEAR_M = 4000;
export const SHORE_MAX_FAR_M = 40000;

export interface LandMask {
  /** Fine grid (10 m/texel over ~12 km). */
  near: THREE.DataTexture;
  /** Coarse grid (~137 m/texel out to the horizon). */
  far: THREE.DataTexture;
  /** Distance from each water texel to the nearest land, sqrt-encoded; see encodeShoreDistance. */
  shoreNear: THREE.DataTexture;
  shoreFar: THREE.DataTexture;
  /** Half-width in metres each texture spans about the scene origin. */
  nearExtent: number;
  farExtent: number;
  /** False when the city has no pack, so the shader can fall back to the
   *  elevation heuristic instead of shading the world as bare ground. */
  has: boolean;
}

function texture(data: Uint8Array, n: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  // LINEAR, both ways. The grid is one-hot, so the filter is what produces the
  // shoreline ramp; a nearest sample would put a hard 10 m staircase along
  // every coast. No mipmaps: the far level already IS the downsample, and a
  // mip chain would average a coastline into half-water at altitude.
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function shoreTexture(level: LandLevel, maxM: number): THREE.DataTexture {
  const enc = encodeShoreDistance(shoreDistanceM(level), maxM);
  const t = new THREE.DataTexture(enc, level.n, level.n, THREE.RedFormat, THREE.UnsignedByteType);
  // Rows of an R8 texture are not 4-byte aligned for every n.
  t.unpackAlignment = 1;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

export function buildLandMask(pack: LandPack): LandMask {
  const near = pack.levels[0];
  // A one-level pack is not a format the baker writes, but falling back to the
  // near level costs a line and beats sampling undefined.
  const far = pack.levels[1] ?? near;
  return {
    near: texture(buildLandMaskRGBA(near), near.n),
    far: texture(buildLandMaskRGBA(far), far.n),
    shoreNear: shoreTexture(near, SHORE_MAX_NEAR_M),
    shoreFar: shoreTexture(far, SHORE_MAX_FAR_M),
    nearExtent: near.extentM,
    farExtent: far.extentM,
    has: true,
  };
}

/** All-zero 1x1 textures for a city with no pack. Every channel reads 0, so
 *  nothing is water, built, vegetated or bare, and `has: false` is what makes
 *  the shader ignore them entirely. */
export function emptyLandMask(): LandMask {
  const blank = (): THREE.DataTexture => texture(new Uint8Array(4), 1);
  const blankShore = (): THREE.DataTexture => {
    const t = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  };
  return {
    near: blank(), far: blank(), shoreNear: blankShore(), shoreFar: blankShore(),
    nearExtent: 1, farExtent: 1, has: false,
  };
}
