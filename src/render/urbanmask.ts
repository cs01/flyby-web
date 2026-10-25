// A coarse map of where the city actually is, built from the baked building
// footprints.
//
// Night lighting needs to know which ground is built up. Inferring that from
// the satellite drape does not work: the drape is a DAYLIGHT PHOTOGRAPH, and
// Esri's imagery is bright and desaturated over beaches, bare hillsides,
// runways and parking as readily as over streets. Every threshold I tried
// either lit the whole map (San Francisco glowing sepia to the coastline) or
// lit almost nothing.
//
// The building pack is not an inference. It is the actual footprints, so a
// low-resolution coverage grid over them says exactly where the city is, and
// where it stops. Parks, water and open country come out dark because nothing
// is built on them.

import * as THREE from "three";
import type { CityPack } from "../data/citypack";

/** Grid resolution. 192 over a ~16 km scene is ~85 m per texel, which is the
 *  right scale: a city block reads as lit, a single house does not. */
const N = 192;

export interface UrbanMask {
  texture: THREE.DataTexture;
  /** Half-width in metres the texture spans about the scene origin. */
  extent: number;
  /** The city as one disc of upward light, for render/skyglow.ts. */
  glow: CityGlow;
}

/**
 * The built-up area reduced to a disc: the density-weighted centroid, the
 * radius of a fully built disc of the same covered area, and the floor area
 * ratio inside it (total floor area over covered ground), which is what sets
 * how many lit windows and lamps a square metre of the city holds.
 */
export interface CityGlow {
  cx: number;
  cz: number;
  radius: number;
  far: number;
}

export function buildUrbanMask(pack: CityPack): UrbanMask {
  const extent = Math.max(2000, pack.radiusM);
  const cell = (extent * 2) / N;
  const acc = new Float32Array(N * N);

  let floorArea = 0;
  for (const b of pack.buildings) {
    // Footprint area, so a tower block counts for more than a shed. Bounding
    // box is close enough at this resolution and far cheaper than the polygon.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < b.ring.length; i += 2) {
      const x = b.ring[i], z = b.ring[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const area = Math.max(0, (maxX - minX) * (maxZ - minZ));
    // 3.5 m storeys. The bounding box overstates an L-shaped footprint by
    // about as much on every building, which the ratio below divides out.
    floorArea += area * Math.max(1, (b.topM - b.baseM) / 3.5);
    const gx = Math.floor((b.cx + extent) / cell);
    const gz = Math.floor((b.cz + extent) / cell);
    if (gx < 0 || gx >= N || gz < 0 || gz >= N) continue;
    acc[gz * N + gx] += area;
  }

  // Normalise against a high percentile rather than the maximum: one enormous
  // footprint (an airport terminal, a rail yard) would otherwise push every
  // ordinary block down to near zero.
  const sorted = Float32Array.from(acc).sort();
  const p98 = sorted[Math.floor(sorted.length * 0.98)] || 1;

  // Blur once. Street lighting does not stop at a block boundary, and an
  // unblurred grid shows its own texels as squares from the air.
  const blurred = new Float32Array(N * N);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      let sum = 0;
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = x + dx, sz = z + dz;
          if (sx < 0 || sx >= N || sz < 0 || sz >= N) continue;
          sum += acc[sz * N + sx];
          n++;
        }
      }
      blurred[z * N + x] = sum / n;
    }
  }

  const data = new Uint8Array(N * N);
  let wSum = 0, wx = 0, wz = 0, footprint = 0;
  for (let i = 0; i < data.length; i++) {
    const d = Math.min(1, blurred[i] / p98);
    data[i] = Math.round(255 * Math.sqrt(d));
    const x = ((i % N) + 0.5) * cell - extent;
    const z = (Math.floor(i / N) + 0.5) * cell - extent;
    wSum += d; wx += d * x; wz += d * z;
    footprint += acc[i];
  }
  const covered = wSum * cell * cell;
  // Floor area over the covered ground; footprint/covered is the site
  // coverage it implies, so the FAR is floor area per covered square metre.
  const glow: CityGlow = wSum > 0
    ? { cx: wx / wSum, cz: wz / wSum, radius: Math.sqrt(covered / Math.PI), far: footprint > 0 ? floorArea / covered : 0 }
    : { cx: 0, cz: 0, radius: 0, far: 0 };

  const texture = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return { texture, extent, glow };
}

/** An all-dark mask, for a city with no baked pack. */
export function emptyUrbanMask(): UrbanMask {
  const data = new Uint8Array(1);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  texture.needsUpdate = true;
  return { texture, extent: 1, glow: { cx: 0, cz: 0, radius: 0, far: 0 } };
}
