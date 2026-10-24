// Where the shrubs go: the same absolute-lattice placement as the trees in
// src/data/trees.ts, driven by the classes the tree channel leaves out.
//
// WHY ITS OWN MASK. The GPU landcover texture folds shrubland, grassland, crop,
// wetland and moss into one "herbaceous" channel, because the terrain shader
// only needs to know the ground is vegetated. A shrub is the one thing that
// needs the distinction back: WorldCover class 20 (shrubland) is chaparral and
// coyote brush, a mound every few metres, while class 30 (grassland) carries
// the odd isolated bush and class 40 (cropland) carries none. The raw class
// codes are still on the CPU, so this builds its own coverage grid from them
// rather than guessing from the folded channel.
//
// Every invariant from trees.ts holds and for the same reasons: the lattice
// is absolute, density IS the coverage (scaled by a per-class constant, not a
// curve), and rejection is by evidence (water, built, footprints,
// carriageways, a slope too steep to hold soil).

import { LandClass, type LandLevel } from "./landcover";
import { sampleMaskBilinear } from "./landmask";
import type { FootprintMask, RoadBlocker, TreeInstance, TreeMask } from "./trees";

/** Lattice pitch, metres: one shrub per cell at full shrubland. */
export const SHRUB_SPACING_M = 6;

/**
 * Shrubs per lattice cell, by WorldCover class.
 *
 * Shrubland is not closed canopy: chaparral is mounds with straw or bare soil
 * between them, so 0.8 of the 6 m cells, with crowns that touch where it is
 * densest. Nothing else: a grassland texel is grass, and the first version
 * that gave grassland a scattered bush put green pillows on Central Park's
 * Sheep Meadow, which is mown.
 *
 * TREE carries shrubs too, and that is a measurement of WorldCover rather than
 * a guess about the ground. Counted over the Marin headlands on the sf pack's
 * far level: 53.1% tree, 13.4% grass, 1.0% shrub. The imagery there is coastal
 * scrub, not forest; WorldCover calls dense coyote brush "tree cover". Under a
 * real canopy a shrub is understorey, which a forest has anyway.
 */
const SHRUBS_PER_CELL: Readonly<Record<number, number>> = {
  [LandClass.Shrub]: 0.8,
  [LandClass.Tree]: 0.3,
};

/**
 * The same, for a level the tree field does not plant. render/trees.ts plants
 * only inside the near level (6 km), so past it the tree class is drawn by
 * nothing but the drape, and on the Marin headlands, 53% tree by WorldCover,
 * that left bare green hills under the shrubland's 1%. Out there the shrubs
 * stand in for the whole canopy at the shrubland's own density: low scrub is
 * what the imagery of those headlands actually shows.
 */
const SHRUBS_PER_CELL_NO_TREES: Readonly<Record<number, number>> = {
  [LandClass.Shrub]: 0.8,
  [LandClass.Tree]: 0.8,
};

/** Coverage above which a candidate stands in water or on a roof. */
export const SHRUB_MAX_WATER = 0.05;
export const SHRUB_MAX_BUILT = 0.4;
/** Ground steeper than this (rise over run, ~42 degrees) holds no shrub. */
export const SHRUB_MAX_SLOPE = 0.9;

/** Visible height range, metres, ground to crown top. */
export const SHRUB_MIN_HEIGHT_M = 0.8;
export const SHRUB_MAX_HEIGHT_M = 3.0;

/**
 * Coverage grid for shrubs, RGBA8 in the same layout sampleMaskBilinear reads:
 * R water, G built, B shrubs per cell (0..1), A unused. `treesPlanted` is
 * false for a level the tree field does not reach; see
 * SHRUBS_PER_CELL_NO_TREES.
 *
 * B is in the channel sampleMaskBilinear calls `tree`; the name is the tree
 * mask's, the number is this one.
 */
export function buildShrubMaskRGBA(level: LandLevel, treesPlanted = true): Uint8Array {
  const { cls } = level;
  const table = treesPlanted ? SHRUBS_PER_CELL : SHRUBS_PER_CELL_NO_TREES;
  const rgba = new Uint8Array(cls.length * 4);
  for (let t = 0; t < cls.length; t++) {
    const c = cls[t];
    const o = t * 4;
    if (c === LandClass.Water || c === LandClass.NoData) rgba[o] = 255;
    else if (c === LandClass.Built) rgba[o + 1] = 255;
    rgba[o + 2] = Math.round(255 * (table[c] ?? 0));
  }
  return rgba;
}

export interface ShrubField {
  /** The finest level, used inside its own extent. */
  near: TreeMask;
  /** A coarser level that reaches further, used past the near one; may be null. */
  far: TreeMask | null;
  heightAt: (x: number, z: number) => number;
  roads?: RoadBlocker | null;
  footprints?: FootprintMask | null;
}

/** How far a shrub field can be planted from the origin, in metres. */
export function shrubFieldExtentM(field: ShrubField): number {
  return Math.max(field.near.extentM, field.far ? field.far.extentM : 0);
}

/**
 * The near level until 98% of its half-width, then the far one. The two do not
 * blend: a shrub is accepted or not on one hash, and a candidate a texel
 * either side of the switch sampling different levels is invisible at a 6 m
 * pitch, while a crossfade would cost two samples per candidate everywhere.
 */
function sampleField(field: ShrubField, x: number, z: number): { water: number; built: number; shrub: number } {
  const n = field.near;
  const inNear = Math.max(Math.abs(x), Math.abs(z)) < n.extentM * 0.98;
  const m = inNear || !field.far ? n : field.far;
  const s = sampleMaskBilinear(m.rgba, m.n, m.extentM, x, z);
  return { water: s.water, built: s.built, shrub: s.tree };
}

function hashCell(i: number, k: number, salt: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(k, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Distinct from every salt in trees.ts, so a shrub cell and a tree cell with
// the same indices do not share their jitter or their acceptance.
const SALT_JX = 0x6a09e667;
const SALT_JZ = 0x3f84d5b5;
const SALT_ACCEPT = 0x243f6a88;
const SALT_SIZE = 0x85a308d3;
const SALT_YAW = 0x13198a2e;
const SALT_TINT = 0x03707344;
const SALT_WIDE = 0xa4093822;
const SALT_CLUMP = 0x299f31d0;
const SALT_CLUMP2 = 0x082efa98;

/**
 * Where the shrubs clump, 0..1 with a mean of about one half: smooth value
 * noise on the same absolute lattice idea, two octaves at 52 m and 19 m.
 *
 * Scrub does not grow as a uniform sprinkle. It grows in stands tens of
 * metres across with grass between, and a field placed at a constant
 * probability read from 120 m up as green pepper on the hillside. The clump
 * field multiplies the acceptance by 2x it, so the MEAN density is still the
 * measured coverage and only its arrangement changes.
 */
export function shrubClump(x: number, z: number): number {
  const oct = (sx: number, sz: number, salt: number): number => {
    const i = Math.floor(sx), k = Math.floor(sz);
    const fx = sx - i, fz = sz - k;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = hashCell(i, k, salt), b = hashCell(i + 1, k, salt);
    const c = hashCell(i, k + 1, salt), d = hashCell(i + 1, k + 1, salt);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  };
  const v = 0.65 * oct(x / 52, z / 52, SALT_CLUMP) + 0.35 * oct(x / 19 + 7.3, z / 19 + 3.1, SALT_CLUMP2);
  // Contrast stretched about the middle: a sum of two value noises piles up
  // near 0.5, and an unstretched one made every stand half full.
  return Math.min(1, Math.max(0, (v - 0.5) * 2.2 + 0.5));
}

/** Fraction of a cell a candidate may sit off its centre; under 1 so it never leaves. */
const SHRUB_JITTER = 0.9;

/**
 * Broadleaf crown base as a fraction of total height (treemesh.ts). A shrub is
 * that crown with its stem sunk into the ground, so the mound sits on the soil.
 */
export const SHRUB_CROWN_BASE = 0.38;

/**
 * Every shrub whose lattice cell puts it inside [x0, x1) x [z0, z1). Half-open,
 * so abutting tiles partition the lattice exactly, as placeTrees does.
 *
 * Returned as TreeInstance so the canopy renderer draws them unchanged:
 * `heightM` is the height of the WHOLE broadleaf (stem included) and `y` is
 * sunk by its stem, so what shows above the ground is a crown between
 * SHRUB_MIN_HEIGHT_M and SHRUB_MAX_HEIGHT_M tall.
 */
export function placeShrubs(
  field: ShrubField,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  out: TreeInstance[] = [],
): TreeInstance[] {
  const sp = SHRUB_SPACING_M;
  const i0 = Math.floor(x0 / sp) - 1;
  const i1 = Math.floor(x1 / sp) + 1;
  const k0 = Math.floor(z0 / sp) - 1;
  const k1 = Math.floor(z1 / sp) + 1;
  for (let k = k0; k <= k1; k++) {
    for (let ic = i0; ic <= i1; ic++) {
      const x = (ic + 0.5 + (hashCell(ic, k, SALT_JX) - 0.5) * SHRUB_JITTER) * sp;
      const z = (k + 0.5 + (hashCell(ic, k, SALT_JZ) - 0.5) * SHRUB_JITTER) * sp;
      if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;

      const s = sampleField(field, x, z);
      if (s.water > SHRUB_MAX_WATER || s.built > SHRUB_MAX_BUILT) continue;
      const clump = shrubClump(x, z);
      if (hashCell(ic, k, SALT_ACCEPT) >= s.shrub * 2 * clump) continue;
      if (field.footprints && field.footprints.occupied(x, z)) continue;
      if (field.roads && field.roads.blocked(x, z)) continue;

      // Slope from the height field two metres either side. A shrub on a
      // sea cliff is a ball stuck to a wall.
      const hx = field.heightAt(x + 2, z) - field.heightAt(x - 2, z);
      const hz = field.heightAt(x, z + 2) - field.heightAt(x, z - 2);
      if (Math.hypot(hx, hz) / 4 > SHRUB_MAX_SLOPE) continue;

      const visible = SHRUB_MIN_HEIGHT_M
        + (SHRUB_MAX_HEIGHT_M - SHRUB_MIN_HEIGHT_M) * hashCell(ic, k, SALT_SIZE) ** 1.5;
      const heightM = visible / (1 - SHRUB_CROWN_BASE);
      // Mounds are wider than tall, more so where the stand is dense and the
      // crowns have grown into each other.
      // About as wide as tall, a little wider inside a dense stand where the
      // mounds grow into each other. Twice as wide as tall read as cushions.
      const radiusM = visible * (0.5 + 0.35 * hashCell(ic, k, SALT_WIDE)) * (0.9 + 0.5 * clump);
      out.push({
        x,
        y: field.heightAt(x, z) - SHRUB_CROWN_BASE * heightM,
        z,
        heightM,
        radiusM,
        yaw: hashCell(ic, k, SALT_YAW) * Math.PI * 2,
        species: 0,
        // The darker half of the canopy ramp: chaparral is a dark, dusty olive
        // against the straw, not a street tree's lime.
        tint: 0.05 + 0.4 * hashCell(ic, k, SALT_TINT),
      });
    }
  }
  return out;
}
