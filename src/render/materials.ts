// The photographed wall and roof materials: which CC0 scans they are, how big
// one tile of each is on a real building, and how the shader may shuffle it.
//
// Pure: no THREE, no DOM. tools/bake-materials.ts reads this table to build the
// texture arrays in public/materials, the browser loader reads it to bind them,
// and test/archetype.check.ts reads it to gate the manifest the bake wrote. One
// table, three readers, so the layer an archetype names is the layer the GPU has.
//
// WHY PHOTOGRAPHS. Everything on a facade before this was arithmetic: a flat
// albedo with a mortar stripe ruled on it. From two metres that reads as a
// model whatever the window grid does, because no real wall is one colour.
// These are photogrammetry and procedural scans from ambientCG, CC0, credited
// in public/materials/CREDITS.md.
//
// THE SHADER NEVER SHOWS A SCAN'S OWN COLOUR. It shows the scan's variation
// around its own mean (texel / mean, per channel, in linear) multiplied by the
// building's palette colour. That is what lets one red-brick scan be a buff
// brick on the next block and a brownstone on the one after, and it is why the
// bake measures each layer's mean rather than trusting the file.

/** Layer indices into the material texture arrays. The order IS the array. */
export enum Mat {
  RedBrick = 0,
  OldBrick = 1,
  BrownBrick = 2,
  BuffBrick = 3,
  PaintedBrick = 4,
  Limestone = 5,
  BlockStone = 6,
  Terracotta = 7,
  Precast = 8,
  BoardConcrete = 9,
  Stucco = 10,
  Siding = 11,
  MetalPanel = 12,
  Granite = 13,
  Gravel = 14,
  Tar = 15,
}

export const MAT_COUNT = 16;

export interface MaterialSpec {
  key: string;
  /** ambientCG asset id. The bake downloads `<id>_1K-JPG.zip`. */
  acg: string;
  /**
   * The real-world module the scan repeats on, metres, along (x, y): one
   * brick-plus-joint and one course for brick, one board for siding, 0 where
   * the material has no lattice.
   *
   * This, not the scan's stated size, is what sets the scale. ambientCG states
   * a size for most of these and not for all, and a stated size is the
   * photographer's estimate; a US modular brick course is 66.7 mm (three
   * courses to eight inches) on every brick wall in the country. The bake
   * measures how many pixels one course takes in the scan (autocorrelation of
   * the height map) and divides, so a scan photographed at any distance lands
   * at the right size on the wall.
   */
  moduleM: [number, number];
  /** Tile size in metres, used when moduleM is 0 on that axis. */
  fallbackM: [number, number];
  /**
   * How much of the scan's own variation survives, 0..1. A weathered timber
   * board has grain the paint on a Victorian hides, and a polished granite
   * plinth is nearly uniform; the brick and stone scans keep all of theirs.
   */
  contrast: number;
}

// Course 66.7 mm is the US modular brick (2 1/4 in brick, 3/8 in joint, three
// courses to 8 in); 203 mm is one brick plus a joint along the course. NYC
// common brick from before 1930 runs 2 1/4 to 2 1/2 in, so 70 mm for the old
// scans. Limestone ashlar courses on NYC and Chicago pre-war bases run 0.45 to
// 0.75 m (Indiana limestone is quarried and sawn to 24 in heights); terracotta
// facing blocks on Chicago School fronts are 12 x 18 to 18 x 24 in units.
export const MATERIALS: MaterialSpec[] = [
  { key: "redbrick", acg: "Bricks086", moduleM: [0.203, 0.0667], fallbackM: [2.6, 1.3], contrast: 1.0 },
  { key: "oldbrick", acg: "Bricks082A", moduleM: [0.21, 0.070], fallbackM: [1.5, 1.5], contrast: 1.0 },
  { key: "brownbrick", acg: "Bricks054", moduleM: [0.203, 0.0667], fallbackM: [1.05, 1.05], contrast: 0.9 },
  { key: "buffbrick", acg: "Bricks105", moduleM: [0.203, 0.0667], fallbackM: [2.4, 1.2], contrast: 1.0 },
  { key: "paintedbrick", acg: "Bricks060", moduleM: [0.203, 0.0667], fallbackM: [1.05, 1.05], contrast: 0.8 },
  { key: "limestone", acg: "Bricks103", moduleM: [0, 0.61], fallbackM: [3.0, 3.0], contrast: 0.9 },
  { key: "blockstone", acg: "Bricks064", moduleM: [0, 0.61], fallbackM: [2.4, 2.4], contrast: 0.8 },
  { key: "terracotta", acg: "Tiles139", moduleM: [0, 0.46], fallbackM: [2.0, 2.0], contrast: 0.8 },
  { key: "precast", acg: "Concrete034", moduleM: [0, 0], fallbackM: [2.2, 1.1], contrast: 0.9 },
  { key: "boardconcrete", acg: "Concrete046", moduleM: [0, 0], fallbackM: [2.4, 2.4], contrast: 1.0 },
  { key: "stucco", acg: "Plaster003", moduleM: [0, 0], fallbackM: [1.6, 1.6], contrast: 0.9 },
  { key: "siding", acg: "WoodSiding009", moduleM: [0, 0.15], fallbackM: [2.4, 1.2], contrast: 0.55 },
  { key: "metalpanel", acg: "Metal032", moduleM: [0, 0], fallbackM: [1.5, 1.5], contrast: 0.7 },
  { key: "granite", acg: "Granite001A", moduleM: [0, 0], fallbackM: [0.8, 0.8], contrast: 0.8 },
  { key: "gravel", acg: "Gravel022", moduleM: [0, 0], fallbackM: [1.5, 1.5], contrast: 1.0 },
  { key: "tar", acg: "Asphalt019", moduleM: [0, 0], fallbackM: [3.0, 3.0], contrast: 1.0 },
];

/** Layer resolution per tier. The reduced tier is a phone. */
export const MAT_RES_FULL = 512;
export const MAT_RES_REDUCED = 256;

/** What tools/bake-materials.ts measures and writes to public/materials/manifest.json. */
export interface MaterialManifest {
  layers: number;
  /** Per layer, in MATERIALS order. */
  entries: {
    key: string;
    acg: string;
    /** Mean of the albedo layer, LINEAR rgb: what the shader divides by. */
    mean: [number, number, number];
    /** Metres one tile covers on the wall, (x, y). */
    tileM: [number, number];
    /**
     * Repeats of the lattice across one tile, (x, y), or 0 where there is none.
     * The shader snaps its stochastic offsets to 1 / period, so a brick course
     * shuffled to break up repetition still lands on a brick course.
     */
    period: [number, number];
  }[];
  /** Encoded bytes per resolution, so the gate can hold the download to a budget. */
  bytes: Record<string, number>;
}

/**
 * Download ceiling for the full tier, bytes.
 *
 * Measured against what the rest of a city costs: a baked pack is 3 to 9 MB,
 * a land pack 2 to 6 MB. Three 512 px arrays of sixteen layers at JPEG q85
 * land near 4 MB; this is the line that stops a fourth map or a 1024 px set
 * arriving by accident.
 */
export const MAT_BYTES_FULL_MAX = 6_000_000;
/** And for a phone, which downloads only the 256 px set. */
export const MAT_BYTES_REDUCED_MAX = 1_800_000;
