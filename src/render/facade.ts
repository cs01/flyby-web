// What a building is MADE OF, and which of its windows are lit.
//
// This is pure: no THREE, no DOM, no GL. It exists as its own module because
// the two things in it are the two things about the skyline that were most
// obviously wrong, and neither can be judged by looking at a screenshot:
//
//   * Every building had the same facade. A curtain-wall tower and a brick
//     walk-up shared one window grid, one storey height and one palette, and a
//     street of them repeated hard enough to read as wallpaper.
//
//   * Lit windows were an independent coin flip per cell, which is the exact
//     recipe for a checkerboard. Real buildings light in RUNS -- a whole floor
//     for one tenant, a stairwell core top to bottom, a block of flats where
//     one household's two windows go on together.
//
// Both are statistical claims, so both can be gated. test/facade.check.ts
// measures the run lengths and the family distribution against this module,
// which is why the logic lives here rather than inside the shader.
//
// THE ONE THING TO WATCH. The per-cell occupancy rule exists twice: once as
// `isLit` below, and once as GLSL in `FACADE_GLSL`, because the decision is
// per-fragment and the fragment shader cannot call TypeScript. They are
// deliberately the same four lines in the same order with the same constants,
// and the constants are only written down once (they are packed into the
// parameter texture by `packFacade` and read back by the shader). What is NOT
// shared is the hash function, so the two do not agree window for window --
// they agree in DISTRIBUTION, which is what both the eye and the gate care
// about. Everything else about a facade (colour, storey height, window
// rectangle, glass fraction, the occupancy probabilities themselves) is
// computed HERE, once per building, and the shader only reads it.

// --- deterministic hashing --------------------------------------------------

/**
 * Integer hash to [0,1). Math.imul so it stays in 32-bit lanes and gives the
 * same answer on every engine -- a facade that differed between two runs would
 * make the screenshot harness meaningless.
 */
export function hash3(a: number, b: number, c: number): number {
  let h = (a | 0) * 0x27d4eb2d;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = Math.imul(h ^ (c | 0), 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const h1 = (seed: number, salt: number): number => hash3(seed, salt, 0x9e37);

/** Mix two numbers by a 0..1 hash. */
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// --- families ---------------------------------------------------------------

export enum FacadeFamily {
  /** Curtain wall: continuous glazing, thin mullions, a mirror for the sky. */
  Glass = 0,
  /** Solid brick with punched windows. Most of any real city. */
  Brick = 1,
  /** Painted render or stucco over frame. Pale, matte, small windows. */
  Stucco = 2,
  /** Precast concrete panel, often with a horizontal ribbon window. */
  Concrete = 3,
  /** Cut stone: civic buildings, pre-war offices, banks. */
  Stone = 4,
}

export const FAMILY_COUNT = 5;

export const FAMILY_NAMES = ["glass", "brick", "stucco", "concrete", "stone"] as const;

/**
 * Per-family constants. Every number here is a physical measurement of a real
 * building type, which is why they differ so much: a curtain wall's mullions
 * are 1.5 m apart and a Victorian terrace's windows are 3.3 m apart, and using
 * one grid for both is most of why the old skyline read as extruded polygons.
 */
interface FamilySpec {
  /** Base colour range; a per-building hash picks a point on it. */
  lo: [number, number, number];
  hi: [number, number, number];
  /** Floor-to-floor height, metres. */
  storeyM: number;
  /** Window column pitch, metres. */
  columnM: number;
  /** Window rectangle inside one cell, as fractions: x0, x1, y0, y1. */
  win: [number, number, number, number];
  /** How much of the wall behaves optically as glass, before the height term. */
  glass: number;
  /** 0 = mirror, 1 = fully matte. Drives the specular lobe width. */
  roughness: number;
  /**
   * Normal-incidence reflectance of the GLAZING this family is built with.
   *
   * Not a look knob and not derived from roughness: it is the exterior visible
   * reflectance of a specific glazing product, and the families differ because
   * the products do.
   *
   *   A single air/glass interface reflects 4% at normal incidence, and that is
   *   the number a bare dielectric gets. A PUNCHED WINDOW in a masonry wall is
   *   close to it: the pane has a second surface, but behind that surface is an
   *   unlit room that absorbs nearly all of what reaches it, so almost nothing
   *   comes back out and the wall behaves as one interface.
   *
   *   A CURTAIN WALL does not. It is an insulating glass unit with a
   *   solar-control or low-e coating sputtered onto surface 2 -- a metallic
   *   film whose whole purpose is to reflect, and which sits in front of the
   *   room rather than behind it. Published exterior visible reflectance for
   *   that product runs 0.10 to 0.35 depending on how hard the coating works.
   *   An uncoated clear IGU is already 0.14 on its four air/glass interfaces.
   *
   * This is why a glass tower is a mirror at angles where Schlick off a bare
   * dielectric gives nothing: at 45 degrees a 0.04 surface returns 7% and a
   * 0.22 one returns 27%, and 27% of a bright sky is most of the pixel.
   */
  f0: number;
  /** Depth of the reveal around a window, metres-ish; 0 is a flat facade. */
  relief: number;
  /** Parapet wall above the roof slab, metres. */
  parapetM: number;
}

const FAMILY: Record<FacadeFamily, FamilySpec> = {
  [FacadeFamily.Glass]: {
    lo: [0.19, 0.23, 0.29], hi: [0.38, 0.42, 0.47],
    storeyM: 3.9, columnM: 1.6, win: [0.05, 0.95, 0.08, 0.96],
    glass: 0.92, roughness: 0.06, relief: 0.10, parapetM: 0.9,
    // Solar-control coated IGU, the standard commercial curtain wall since the
    // 1970s. Mid of the 0.10-0.35 product range: brighter than a plain low-e
    // unit, short of the 1980s mirror glass that would make every tower a
    // chrome slab.
    f0: 0.22,
  },
  [FacadeFamily.Brick]: {
    lo: [0.31, 0.15, 0.11], hi: [0.54, 0.31, 0.23],
    storeyM: 3.1, columnM: 3.3, win: [0.29, 0.71, 0.28, 0.82],
    glass: 0.20, roughness: 0.86, relief: 0.75, parapetM: 1.0,
    f0: 0.05,   // punched sash over a dark room: one effective interface
  },
  [FacadeFamily.Stucco]: {
    lo: [0.44, 0.41, 0.35], hi: [0.68, 0.64, 0.55],
    storeyM: 3.0, columnM: 3.0, win: [0.25, 0.75, 0.26, 0.84],
    glass: 0.22, roughness: 0.78, relief: 0.50, parapetM: 0.7,
    f0: 0.05,   // same punched window, rendered wall rather than brick
  },
  [FacadeFamily.Concrete]: {
    lo: [0.31, 0.31, 0.30], hi: [0.58, 0.57, 0.55],
    storeyM: 3.5, columnM: 2.4, win: [0.13, 0.87, 0.24, 0.78],
    glass: 0.45, roughness: 0.62, relief: 0.55, parapetM: 1.1,
    // THE FAMILY WITH NO ONE GLAZING TYPE. It spans a four-storey block with
    // punched holes and a forty-storey ribbon-windowed slab, and those are not
    // the same product. It gets the uncoated clear IGU at 0.14 -- the four
    // air/glass interfaces of a double-glazed unit with no coating on any of
    // them -- which is right for the ribbon window and generous for the punched
    // one, and the glassFrac term already carries most of that difference.
    f0: 0.14,
  },
  [FacadeFamily.Stone]: {
    lo: [0.42, 0.39, 0.34], hi: [0.63, 0.59, 0.52],
    storeyM: 4.2, columnM: 3.6, win: [0.30, 0.70, 0.24, 0.84],
    glass: 0.18, roughness: 0.72, relief: 0.80, parapetM: 1.4,
    f0: 0.05,   // masonry stock, single glazed or clear IGU in a deep reveal
  },
};

/**
 * What a DETACHED HOUSE does differently from the block of flats it shares a
 * facade family with.
 *
 * The specs above were measured on multi-storey buildings and were being
 * applied unchanged to a two-storey house: Stucco is a 3.0 x 3.0 m cell with a
 * 0.50 x 0.58 window in it, which is a 29% window-to-wall ratio on every cell
 * of a uniform lattice. A US detached single-family house is 12-18% WWR, and
 * what gets it there is SPARSITY rather than a smaller pane: two to four
 * openings per elevation with blank wall between them, not a grid.
 *
 * Only the geometry moves. The family still picks the colour and the material,
 * because a house is genuinely brick or render or board, and which one is the
 * same regional question it is for a walk-up.
 */
const HOUSE = {
  /** US residential floor-to-floor is 2.7-3.0 m; the families are 3.0-4.2. */
  storeyM: 2.85,
  /** Windows on a house sit further apart than on a terrace. */
  columnM: 4.3,
  /**
   * The rectangle is NOT the window-to-wall ratio. Only HOUSE_OPEN_FRAC of the
   * cells carry an opening at all, so the glass actually on the wall is the
   * rectangle times the keep, and that product is the 12-18% a real elevation
   * measures. Sized as 15% here, the wall delivered 8.3%, which is a warehouse.
   *
   * 0.54 x 0.50 of a 4.3 x 2.85 m cell is a 2.32 x 1.43 m opening, cill at
   * 0.86 m and head at 2.28 m. Big for one casement, and correctly so: at this
   * column pitch and this keep an opening lands every 7.8 m of elevation, so
   * the one that lands is the paired or triple unit under a single head that a
   * living room actually has, not a bathroom light.
   *
   * 0.27 x 0.55 = 14.9% delivered. test/facade.check.ts gates the delivered
   * figure over every house in every pack and prints this rectangle beside it.
   */
  win: [0.23, 0.77, 0.30, 0.80] as [number, number, number, number],
  /** Board or render over frame: a shallow reveal, not a 200 mm masonry arch. */
  relief: 0.30,
  /** Jitter half-widths, tightened so no seed can leave the 12-18% band. */
  storeyJitter: 0.10,
  columnJitter: 0.13,
  winJitter: 0.035,
};

/**
 * Fraction of cells on a house that carry an opening at all.
 *
 * The other 45% are blank wall. This lives here rather than in the shader
 * because the shader has to converge to it in the far field (see the
 * irregular-opening term in buildings.ts), so the two must be the same number
 * and it may only be written down once.
 */
export const HOUSE_OPEN_FRAC = 0.55;

/**
 * Tallest thing that still counts as a house, metres.
 *
 * 11 m so a 2.5-storey house under a pitched roof still qualifies while a
 * four-storey apartment block does not.
 */
export const HOUSE_MAX_M = 11;

/**
 * Family weights by OSM kind, in four height bands.
 *
 * Height carries most of the decision and that is not a shortcut: in the baked
 * packs 86-90% of every city is tagged `building=yes` (measured: Manhattan
 * 87.0%, Chicago 85.7%, SF 89.9%), so a mapping keyed on the tag alone gives a
 * city of one material. Height is the attribute that IS present on every
 * record and it is also genuinely predictive -- nobody builds a 200 m brick
 * wall that holds itself up, and nobody hangs a curtain wall on a two-storey
 * house.
 *
 * Bands: 0 = under 12 m, 1 = 12-30 m, 2 = 30-70 m, 3 = over 70 m.
 */
const BANDS = [12, 30, 70];

type Weights = [number, number, number, number, number]; // glass, brick, stucco, concrete, stone

const GENERIC_BY_BAND: Weights[] = [
  [0.02, 0.34, 0.34, 0.18, 0.12],
  [0.08, 0.34, 0.24, 0.24, 0.10],
  [0.34, 0.14, 0.08, 0.30, 0.14],
  [0.60, 0.02, 0.02, 0.25, 0.11],
];

/** Multipliers applied to the band weights for a kind that IS tagged. */
const KIND_BIAS: Record<number, Weights> = {
  0: [1, 1, 1, 1, 1],          // Generic
  1: [0.25, 1.7, 1.7, 0.8, 0.5], // Residential: brick and render
  2: [2.2, 0.7, 0.4, 1.2, 1.1],  // Commercial: offices, so more glass
  3: [0.2, 1.2, 0.6, 2.2, 0.2],  // Industrial: concrete and brick sheds
  4: [1.2, 1.1, 1.5, 0.8, 0.5],  // Retail
  5: [0.4, 0.8, 0.5, 0.9, 3.0],  // Civic: stone
  6: [3.2, 0.05, 0.05, 1.0, 0.7], // Tower: steel and glass
};

function bandOf(heightM: number): number {
  for (let i = 0; i < BANDS.length; i++) if (heightM < BANDS[i]) return i;
  return BANDS.length;
}

/** Weighted pick, deterministic in the seed. */
function pickFamily(kind: number, heightM: number, seed: number): FacadeFamily {
  const base = GENERIC_BY_BAND[bandOf(heightM)];
  const bias = KIND_BIAS[kind] ?? KIND_BIAS[0];
  let total = 0;
  const w: number[] = new Array(FAMILY_COUNT);
  for (let i = 0; i < FAMILY_COUNT; i++) {
    w[i] = base[i] * bias[i];
    total += w[i];
  }
  let r = h1(seed, 0x11) * total;
  for (let i = 0; i < FAMILY_COUNT; i++) {
    r -= w[i];
    if (r <= 0) return i as FacadeFamily;
  }
  return FacadeFamily.Concrete;
}

// --- night occupancy --------------------------------------------------------

/**
 * How busy each kind of building is at a given local hour.
 *
 * Offices and homes empty at different times and that difference is visible
 * from the air: at midnight a residential block still has a scatter of lights
 * in it and an office tower is down to its cleaners and its stairwell. Both
 * curves bottom out around 04:00 and neither ever reaches zero, because a real
 * city at 4 a.m. is not dark.
 *
 * Returned as a triple rather than looked up per building because it goes to
 * the GPU as ONE uniform: the hour changes every frame under timelapse, and
 * rebuilding a 60k-entry parameter texture for it would be absurd.
 */
export interface HourFactors {
  residential: number;
  office: number;
  other: number;
}

/**
 * Group a building falls into for the hour curve. 0 home, 1 office, 2 other.
 *
 * The tag decides it where there is one. Where there is not -- which is 86-90%
 * of every pack -- height decides it, because anything over about ten storeys
 * in these cities is offices whatever it is faced in. Keying this on the
 * material instead put pre-war stone towers in with the shops and gave them a
 * tenancy one window wide, which is the per-cell hash all over again.
 */
export function occupancyGroup(family: FacadeFamily, kind: number, heightM: number): number {
  if (kind === 1) return 0;                              // Residential
  if (kind === 2 || kind === 6) return 1;                // Commercial, Tower
  if (kind === 3 || kind === 4 || kind === 5) return 2;  // Industrial, Retail, Civic
  if (heightM >= 30) return 1;
  if (family === FacadeFamily.Glass || family === FacadeFamily.Concrete) return 1;
  if (family === FacadeFamily.Brick || family === FacadeFamily.Stucco) return 0;
  return 2;
}

/** Smooth bump centred on `at`, `width` hours wide, wrapping over midnight. */
function bump(hour: number, at: number, width: number): number {
  let d = Math.abs(hour - at);
  if (d > 12) d = 24 - d;
  const t = Math.min(1, d / width);
  return 1 - t * t * (3 - 2 * t);
}

export function hourFactors(hour: number): HourFactors {
  const h = ((hour % 24) + 24) % 24;
  // Homes: peak 20:00-22:00, still 25% of peak at 04:00.
  const residential = 0.25 + 0.75 * Math.max(bump(h, 21, 7), 0);
  // Offices: peak 19:00, gone by 02:00, a floor of cleaners and the core left.
  const office = 0.12 + 0.88 * Math.max(bump(h, 18.5, 6.5), 0);
  // Shops, depots, civic: shut earliest.
  const other = 0.08 + 0.62 * Math.max(bump(h, 19, 5.5), 0);
  return { residential, office, other };
}

export function hourFactorFor(f: HourFactors, group: number): number {
  return group === 0 ? f.residential : group === 1 ? f.office : f.other;
}

// --- the parameter set ------------------------------------------------------

export interface FacadeParams {
  family: FacadeFamily;
  /** Linear albedo. */
  colour: [number, number, number];
  roughness: number;
  /** Normal-incidence reflectance of this family's glazing; see FamilySpec. */
  f0: number;
  storeyM: number;
  columnM: number;
  /** Window rectangle inside a cell: x0, x1, y0, y1, all 0..1. */
  win: [number, number, number, number];
  /** 0..1: how much of the wall behaves as glass rather than as spandrel. */
  glassFrac: number;
  relief: number;
  parapetM: number;
  /**
   * Floor-to-floor of the GROUND storey, metres.
   *
   * Separate from `storeyM` because a ground floor is never the same height as
   * the flat above it: a shop needs head height over its display and its
   * signage, an office needs a lobby, and even a terraced house sits its front
   * door up a step. Rendering the ground floor as one more repeat of the upper
   * grid is what made every street read as a stack of identical layers with
   * the bottom one dimmed.
   */
  groundStoreyM: number;
  /**
   * How retail the ground floor is, 0..1.
   *
   * 1 is a full glazed shopfront in wide bays with a fascia over it; 0 is a
   * residential base with the same punched windows as the storeys above and a
   * door. It drives the bay width, the glazing, the fascia and how tall the
   * ground storey is, so one number decides the whole band.
   */
  shopfront: number;
  /**
   * 1 if this is a detached house, 0 otherwise. See HOUSE above.
   *
   * A flag and not a family, because a house's MATERIAL is still brick or
   * render or board and the families already say that. What it changes is the
   * geometry (storey, column pitch, window rectangle, reveal) and two rules:
   * a house has no service core to light at night, and its openings are
   * irregular rather than a lattice.
   */
  house: number;

  // Night occupancy. See `isLit` for how these compose.
  /** A whole floor is dark or in use. */
  pFloor: number;
  /** A tenancy block within an occupied floor, before the hour factor. */
  pTenant: number;
  /** One window inside a lit tenancy. Never 1: offices have empty rooms. */
  pCell: number;
  /** A service core stripe, lit from the ground to the roof. */
  pCore: number;
  /** Tenancy block width in window columns. */
  tenantW: number;
  /** Tenancy block height in floors. */
  tenantH: number;
  /** Core stripe width in columns. */
  coreW: number;
  /** One core every this many stripes of `coreW` columns. */
  corePeriod: number;
  /** Which stripe in the period is the core. */
  coreSlot: number;
  /** 0 residential, 1 office, 2 other -- indexes the hour factors. */
  group: number;
  /** Kept for the shader's own noise, and so a facade is traceable to a seed. */
  seed: number;
}

/** Numbers per building written into the parameter texture (6 RGBA texels). */
/**
 * Six RGBA values per building, stored as TWELVE RGBA8 texels.
 *
 * Every value is carried as 16-bit fixed point across two bytes, so one RGBA8
 * texel holds two of them. That is twice the texels of an RGBA32F table and
 * half the bytes, and unlike a float texture it is readable on every GL that
 * exists.
 *
 * The float table was not a premature optimisation, it was a bug: at least one
 * Android device returned all zeros from it as fp32 AND as fp16, while reading
 * every ordinary texture in the scene correctly. Every building then divided by
 * a zero storey height and rendered NaN-black. A plain 8-bit texture is the
 * format a photograph uses and nothing anywhere refuses to sample it.
 */
export const FACADE_TEXELS = 7;
export const FACADE_FLOATS = FACADE_TEXELS * 4;
/** RGBA8 texels per building: two bytes per value. */
export const FACADE_BYTE_TEXELS = FACADE_FLOATS / 2;

/**
 * Fixed-point range. Every value this table stores was measured to lie in
 * 0..20 across every baked city, so 32 leaves headroom without wasting bits:
 * the quantum is 32 / 65535, about 0.0005, which is far finer than fp16 gave.
 */
export const FACADE_ENCODE_MAX = 32;

/** One value to two bytes, low byte first. */
export function encodeFacadeValue(v: number): [number, number] {
  const c = Math.max(0, Math.min(1, v / FACADE_ENCODE_MAX));
  const q = Math.round(c * 65535);
  return [q & 0xff, (q >> 8) & 0xff];
}

/** The exact inverse, so the gate can prove the round-trip. */
export function decodeFacadeValue(lo: number, hi: number): number {
  return ((lo + hi * 256) / 65535) * FACADE_ENCODE_MAX;
}

/**
 * Everything about one building's surface, from its tag, its height and its
 * seed. Pure and total: the same three inputs always give the same answer, on
 * any machine, which is what makes two screenshot runs comparable.
 */
export function facadeFor(kind: number, heightM: number, seed: number): FacadeParams {
  const family = pickFamily(kind, heightM, seed);
  const s = FAMILY[family];

  // Is this a house? osmbuildings.ts now recovers Residential from footprint
  // geometry and neighbour density, so most of a suburb arrives tagged, and a
  // suburb is the case the family specs were never measured on.
  const house = kind === 1 && heightM <= HOUSE_MAX_M ? 1 : 0;

  // Colour: a point on the family's range, then a small per-building shift so
  // two brick buildings side by side are not the same brick.
  const t = h1(seed, 0x21);
  const jr = h1(seed, 0x31) - 0.5;
  const jg = h1(seed, 0x32) - 0.5;
  const jb = h1(seed, 0x33) - 0.5;
  const tone = 1 + 0.14 * (h1(seed, 0x34) - 0.5);
  const colour: [number, number, number] = [
    clamp01(lerp(s.lo[0], s.hi[0], t) * tone + 0.035 * jr),
    clamp01(lerp(s.lo[1], s.hi[1], t) * tone + 0.035 * jg),
    clamp01(lerp(s.lo[2], s.hi[2], t) * tone + 0.035 * jb),
  ];

  // Storey and column pitch vary by a few per cent per building. Real blocks
  // do, and a grid that is identical across a street is the single most
  // obvious tell that a city is procedural.
  const storeyM = (house ? HOUSE.storeyM : s.storeyM)
    * (1 + (house ? HOUSE.storeyJitter : 0.10) * (h1(seed, 0x41) - 0.5));
  const columnM = (house ? HOUSE.columnM : s.columnM)
    * (1 + (house ? HOUSE.columnJitter : 0.18) * (h1(seed, 0x42) - 0.5));

  // Window proportion moves too, and toward MORE glass on a taller building of
  // the same family: a 40-storey concrete tower has ribbon windows, a 4-storey
  // one has punched holes.
  const tall = Math.min(1, Math.max(0, (heightM - 20) / 80));
  // The house jitter is narrower because the WWR band it has to stay inside is
  // narrow: the two axes shrink TOGETHER on this one hash, so at the family's
  // +/-0.03 the DELIVERED glazing would run 12.0% to 18.0%, sitting on both
  // edges of the band at once. At +/-0.0175 it runs 13.2% to 16.6%.
  const wj = (house ? HOUSE.winJitter : 0.06) * (h1(seed, 0x43) - 0.5);
  const wb = house ? HOUSE.win : s.win;
  const win: [number, number, number, number] = [
    clamp01(lerp(wb[0], wb[0] * 0.45, tall) + wj),
    clamp01(lerp(wb[1], 1 - (1 - wb[1]) * 0.45, tall) - wj),
    clamp01(wb[2] + wj),
    clamp01(wb[3] - wj * 0.5),
  ];

  // Glass is a property of the family first and of the height second. A tall
  // brick building does not become a curtain wall, it just has bigger windows.
  // Height pushes the glass fraction up hard. A four-storey concrete building
  // has punched windows; the same concrete at forty storeys is a ribbon window
  // with a spandrel panel between the floors, which is far more glass and far
  // darker. Without this, tall non-glass buildings came out as pale slabs and
  // a night skyline was full of them.
  const glassFrac = clamp01(s.glass * (0.82 + 0.36 * h1(seed, 0x44)) * (1 + 0.55 * tall));

  // A CORE THE RULE CAN ACTUALLY REACH.
  //
  // The slot has to be drawn modulo the period, not out of the widest period
  // there is. It used to be `floor(hash * CORE_PERIOD_MAX)` against a period of
  // 7..14, so a slot past the period made `mod(coreIdx, corePeriod) ===
  // coreSlot` unsatisfiable and the building had NO service core, while
  // meanOccupancy went on charging it (1/corePeriod) * pCore. Measured over the
  // packs: 24.9% of every building in every one of them, exactly the arithmetic
  // (the mean of (14-p)/14 over p in 7..14 is 28/112), and the far field of an
  // affected building sat up to 2.3x above the lit fraction its near field drew.
  // test/facade.check.ts gates both halves now.
  const corePeriod = CORE_PERIOD_MIN + Math.floor(h1(seed, 0x58) * (CORE_PERIOD_MAX - CORE_PERIOD_MIN + 1));
  const coreSlot = Math.floor(h1(seed, 0x59) * CORE_PERIOD_MAX) % corePeriod;

  const group = occupancyGroup(family, kind, heightM);
  const office = group === 1;

  // How shop-like the ground floor is. Kind carries most of it and height
  // carries the rest: a retail unit is a shopfront, a warehouse is a roller
  // shutter, and the base of any tall building in a city centre is let to
  // somebody who wants a window on the street whatever the tag says.
  const shopBias = SHOPFRONT_BY_KIND[kind] ?? SHOPFRONT_BY_KIND[0];
  const shopfront = clamp01(
    shopBias * (0.55 + 0.9 * h1(seed, 0x61)) + 0.35 * Math.min(1, Math.max(0, (heightM - 10) / 40)),
  );
  // A ground storey runs from a little over the upper storeys (a house) to
  // half again as tall (a shop or a lobby), and is then bounded by literals so
  // no seed can produce a two-metre shop or a seven-metre terraced house.
  const groundStoreyM = Math.min(
    GROUND_STOREY_MAX_M,
    Math.max(
      GROUND_STOREY_MIN_M,
      storeyM * lerp(1.04, 1.55, shopfront) * (1 + 0.10 * (h1(seed, 0x62) - 0.5)),
    ),
  );

  return {
    family,
    colour,
    roughness: clamp01(s.roughness * (1 + 0.2 * (h1(seed, 0x45) - 0.5))),
    // No per-building jitter. Two curtain walls on one street are glazed in
    // the same generation of product far more reliably than they are the same
    // colour, and a randomised reflectance reads as a rendering error rather
    // than as variety.
    f0: s.f0,
    storeyM,
    columnM,
    win,
    glassFrac,
    relief: (house ? HOUSE.relief : s.relief) * (0.8 + 0.4 * h1(seed, 0x46)),
    parapetM: s.parapetM * (0.7 + 0.6 * h1(seed, 0x47)),
    groundStoreyM,
    shopfront,
    house,

    // An office empties floor by floor; a block of flats empties flat by flat.
    // So an office gets a high per-floor gate and wide tenancies, and housing
    // gets an almost-always-occupied floor and tenancies two windows wide.
    pFloor: office ? lerp(0.50, 0.80, h1(seed, 0x51)) : lerp(0.72, 0.95, h1(seed, 0x51)),
    pTenant: office ? lerp(0.55, 0.90, h1(seed, 0x52)) : lerp(0.42, 0.72, h1(seed, 0x52)),
    // Never near 1: an occupied floor still has empty meeting rooms in it, and
    // a lit flat still has a dark bedroom. But not low either -- at 0.55 a
    // tenancy came out as a dotted line rather than as a lit tenancy.
    pCell: office ? lerp(0.72, 0.92, h1(seed, 0x53)) : lerp(0.72, 0.92, h1(seed, 0x53)),
    pCore: lerp(0.55, 0.9, h1(seed, 0x54)),
    // A tenancy is a floor of an office or a flat in a block, and a flat is
    // two or three windows wide, not one. One column wide would BE the old
    // per-cell hash, which is the thing this whole model exists to replace.
    tenantW: office ? 3 + Math.floor(h1(seed, 0x55) * 6) : 2 + Math.floor(h1(seed, 0x55) * 3),
    tenantH: office ? 1 + Math.floor(h1(seed, 0x56) * 3) : 1 + Math.floor(h1(seed, 0x56) * 2),
    coreW: 1 + Math.floor(h1(seed, 0x57) * 2),
    corePeriod,
    coreSlot,
    group,
    seed: (seed % 4096) / 4096,
  };
}

/**
 * How often a service core recurs, counted in stripes of `coreW` columns.
 *
 * Bounded from LITERALS rather than from whatever the code happens to do,
 * because the core is what supplies the vertical runs: if the period grew
 * without bound the cores would vanish off the ends of every wall and the
 * night city would go back to being uncorrelated up the building.
 */
export const CORE_PERIOD_MIN = 7;
export const CORE_PERIOD_MAX = 14;

/**
 * Bounds on the ground storey, metres.
 *
 * From LITERALS and not from `storeyM`, so a family with an unusual storey
 * height cannot produce a ground floor a person could not walk into or one
 * that swallows a whole small building. test/pavement.check.ts asserts both
 * the constants and every sampled building against its own literals.
 */
export const GROUND_STOREY_MIN_M = 2.9;
export const GROUND_STOREY_MAX_M = 6.0;

/**
 * How shop-like each OSM kind's ground floor is, before the per-building hash.
 * Indexed exactly as KIND_BIAS above.
 */
const SHOPFRONT_BY_KIND: Record<number, number> = {
  0: 0.40, // Generic
  1: 0.12, // Residential   a front door and a bay window, not a shop
  2: 0.72, // Commercial
  3: 0.06, // Industrial    a shutter and a personnel door
  4: 0.95, // Retail
  5: 0.35, // Civic         a portico, not a display window
  6: 0.65, // Tower         a glazed lobby, whatever is let above it
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// --- occupancy: the rule the shader mirrors ---------------------------------

/**
 * Is the window at (col, floor) lit?
 *
 * Four gates in series, and the ORDER is what produces runs rather than noise:
 *
 *   1. a service core stripe is lit from the ground to the roof, or not at all
 *      -- this is where the long VERTICAL runs come from, and it is the thing
 *      every night photograph of an office block has in it;
 *   2. a floor is in use or it is dark, whole;
 *   3. within a floor in use, a tenancy of several columns is lit together --
 *      the long HORIZONTAL runs;
 *   4. only then does an individual window get its own coin.
 *
 * The old code was step 4 alone, which is independent and identically
 * distributed across the wall, which is the mathematical definition of the
 * checkerboard it produced.
 *
 * `heightFade` is the "upper floors go dark first" term, passed in because the
 * shader has it as a continuous function of height up the wall.
 */
export function isLit(
  p: FacadeParams,
  col: number,
  floorIdx: number,
  hourFactor: number,
  heightFade = 1,
): boolean {
  // A house has no lift core and no stair shaft, so it gets no stripe. On two
  // storeys the core rule is correlation with nothing behind it, and it is the
  // thing that draws the ground-to-roof vertical runs an office block has.
  if (!p.house) {
    const coreIdx = Math.floor(col / p.coreW);
    if (mod(coreIdx, p.corePeriod) === p.coreSlot) {
      return hash3(p.seed * 4096, 0x7c07e, coreIdx) < p.pCore;
    }
  }
  if (hash3(p.seed * 4096, 0x5100, floorIdx) > p.pFloor * heightFade) return false;
  const tb = Math.floor(col / p.tenantW);
  const th = Math.floor(floorIdx / p.tenantH);
  if (hash3(p.seed * 4096 + tb * 977, 0x7e14, th) > p.pTenant * hourFactor) return false;
  return hash3(p.seed * 4096 + col * 131, 0xce11, floorIdx) < p.pCell;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * The MEAN lit fraction over a whole facade, in closed form.
 *
 * The shader needs this and not only the per-cell answer: past a couple of
 * kilometres a window is far smaller than a pixel, and point-sampling it
 * sparkles. Everything in `isLit` converges to this product, so the far field
 * can fade to it and stay stable. It is also what the gate checks stays in a
 * sane range at every hour of the night.
 */
export function meanOccupancy(p: FacadeParams, hourFactor: number, heightFade = 1): number {
  // No core on a house, and the mean has to drop the term in exactly the case
  // isLit drops the stripe or the far field stops matching what the near field
  // actually draws. The two are meant to agree by construction.
  const coreFrac = p.house ? 0 : 1 / p.corePeriod;
  const body = p.pFloor * heightFade * Math.min(1, p.pTenant * hourFactor) * p.pCell;
  return coreFrac * p.pCore + (1 - coreFrac) * body;
}

// --- packing ----------------------------------------------------------------

/** Write one building's parameters into the texture backing array. */
export function packFacade(p: FacadeParams, out: Float32Array, i: number): void {
  let o = i * FACADE_FLOATS;
  out[o++] = p.colour[0]; out[o++] = p.colour[1]; out[o++] = p.colour[2]; out[o++] = p.roughness;
  out[o++] = p.storeyM;   out[o++] = p.columnM;   out[o++] = p.glassFrac; out[o++] = p.seed;
  out[o++] = p.win[0];    out[o++] = p.win[1];    out[o++] = p.win[2];    out[o++] = p.win[3];
  out[o++] = p.pFloor;    out[o++] = p.pTenant;   out[o++] = p.pCell;     out[o++] = p.pCore;
  out[o++] = p.tenantW;   out[o++] = p.tenantH;   out[o++] = p.coreW;     out[o++] = p.corePeriod;
  // group and family share a float: both are small integers, the shader wants
  // both, and a seventh texel for four bits would be one more fetch per pixel.
  out[o++] = p.coreSlot;  out[o++] = p.group * 8 + p.family;
  out[o++] = p.relief;    out[o++] = p.parapetM;
  // The ground-storey pair arrived with the seventh texel and was never
  // written: readFacade has always read them, so every building got a zero
  // shopfront and a groundStoreyM clamped to 0.5 m, which put the upper window
  // grid half a metre off the pavement and left the shop band a dark stripe.
  out[o++] = p.groundStoreyM; out[o++] = p.shopfront;
  // `house` rides in a spare component of a texel readFacade already fetches,
  // so it costs no bytes and no extra fetch across 187k buildings. The last
  // component is written anyway: the gate fills the buffer with NaN first, so
  // a slot nobody writes now fails rather than reading as a silent zero.
  out[o++] = p.house;     out[o++] = p.f0;
}

// --- the GLSL half ----------------------------------------------------------

/**
 * The shader's view of all of the above: a fetch out of the parameter texture,
 * plus the transcription of `isLit`.
 *
 * Only the RULE is transcribed. Every constant it uses comes out of the
 * texture, so there is exactly one place -- `facadeFor` -- where a number about
 * a facade is decided, and this cannot drift away from it by having a stale
 * copy of one.
 */
export const FACADE_GLSL = /* glsl */ `
uniform sampler2D uFacade;
uniform float uFacadeWidth;
uniform vec3 uHourFactor;   // residential, office, other

struct Facade {
  vec3  colour;
  float roughness;
  float f0;
  float storeyM;
  float columnM;
  float glassFrac;
  float seed;
  vec4  win;
  float pFloor;
  float pTenant;
  float pCell;
  float pCore;
  float tenantW;
  float tenantH;
  float coreW;
  float corePeriod;
  float coreSlot;
  float group;
  float relief;
  float family;
  float parapetM;
  float groundStoreyM;
  float shopfront;
  float house;
};

// One RGBA8 texel is two 16-bit values: (r,g) is the first, (b,a) the second.
// texture() returns 0..1, so a byte is that times 255, and rounding matters
// because 0.5/255 of drift in the high byte is 128 counts of the value.
vec2 facadePair(float bidx, float k) {
  float t = bidx * ${FACADE_BYTE_TEXELS}.0 + k;
  float y = floor(t / uFacadeWidth);
  vec4 e = texelFetch(uFacade, ivec2(int(t - y * uFacadeWidth), int(y)), 0);
  float lo0 = floor(e.r * 255.0 + 0.5);
  float hi0 = floor(e.g * 255.0 + 0.5);
  float lo1 = floor(e.b * 255.0 + 0.5);
  float hi1 = floor(e.a * 255.0 + 0.5);
  return vec2((lo0 + hi0 * 256.0) / 65535.0, (lo1 + hi1 * 256.0) / 65535.0)
       * ${FACADE_ENCODE_MAX}.0;
}

// The old four-at-a-time accessor, rebuilt on top of the byte pairs so the
// twenty-odd call sites below did not all have to change shape.
vec4 facadeTexel(float bidx, float k) {
  vec2 ab = facadePair(bidx, k * 2.0);
  vec2 cd = facadePair(bidx, k * 2.0 + 1.0);
  return vec4(ab.x, ab.y, cd.x, cd.y);
}

Facade readFacade(float bidx) {
  vec4 a = facadeTexel(bidx, 0.0);
  vec4 b = facadeTexel(bidx, 1.0);
  vec4 c = facadeTexel(bidx, 2.0);
  vec4 d = facadeTexel(bidx, 3.0);
  vec4 e = facadeTexel(bidx, 4.0);
  vec4 f = facadeTexel(bidx, 5.0);
  vec4 g = facadeTexel(bidx, 6.0);
  Facade p;
  p.colour = a.rgb;   p.roughness = a.w;
  p.storeyM = b.x;    p.columnM = b.y;  p.glassFrac = b.z;  p.seed = b.w;
  p.win = c;
  p.pFloor = d.x;     p.pTenant = d.y;  p.pCell = d.z;      p.pCore = d.w;
  p.tenantW = e.x;    p.tenantH = e.y;  p.coreW = e.z;      p.corePeriod = e.w;
  p.coreSlot = f.x;   p.group = floor(f.y / 8.0);  p.family = f.y - p.group * 8.0;
  p.relief = f.z;     p.parapetM = f.w;
  p.groundStoreyM = g.x;  p.shopfront = g.y;  p.house = g.z;  p.f0 = g.w;

  // A DEAD TABLE MUST DEGRADE, NOT BREAK.
  //
  // If the parameter texture never reached the GPU, every texelFetch returns
  // (0,0,0,1). Then storeyM and columnM are 0, vUv / 0 is Inf, fract(Inf) is
  // NaN, and NaN renders black: an entire city black with nothing thrown on the
  // JS side and no way to tell it from a lighting bug.
  //
  // This first shipped as a magenta sentinel, which did its job perfectly. One
  // phone screenshot identified the failure in seconds after two days of
  // guessing at black buildings. But it was a diagnostic, and the diagnosis has
  // been made: at least one Android device cannot read this table as fp32 OR as
  // fp16, so a magenta city is now just a worse black city.
  //
  // So the fallback is a PLAUSIBLE facade instead. It is deliberately NOT a
  // transcription of facadeFor: duplicating that rule in GLSL is exactly the
  // drift this file's design avoids. It is a coarse per-building variation that
  // reads as a city rather than as an error, and it is honest that it is a
  // fallback (uFacadeFallback goes to 1 so the app can say so).
  //
  // corePeriod is >= CORE_PERIOD_MIN (7) by construction for any real record,
  // so a value under 1 cannot come from a healthy read.
  if (p.corePeriod < 1.0) {
    float fb = fract(sin(bidx * 12.9898) * 43758.5453);
    float fb2 = fract(sin(bidx * 78.233) * 24634.6345);
    // Five bands of plausible masonry and concrete, warm to cool.
    p.colour = mix(vec3(0.42, 0.36, 0.31), vec3(0.62, 0.63, 0.64), fb);
    p.colour = mix(p.colour, vec3(0.30, 0.34, 0.38), step(0.82, fb2));
    p.storeyM = 3.1 + 0.5 * fb2;
    p.columnM = 2.4 + 0.6 * fb;
    p.glassFrac = fb2 > 0.82 ? 0.55 : 0.12;
    p.roughness = 0.72;
    p.tenantW = 4.0; p.tenantH = 2.0;
    p.coreW = 2.0; p.corePeriod = 9.0; p.coreSlot = 3.0;
    p.pFloor = 0.75; p.pTenant = 0.6; p.pCell = 0.5; p.pCore = 0.7;
    p.win = vec4(0.18, 0.82, 0.16, 0.86);
    p.relief = 0.5; p.parapetM = 0.9;
    p.group = 1.0; p.family = fb2 > 0.82 ? 0.0 : 1.0;
    p.groundStoreyM = 4.0; p.shopfront = 0.45; p.house = 0.0;
    p.f0 = fb2 > 0.82 ? 0.22 : 0.05;
  }

  // Belt and braces: clamp every divisor at the point of use anyway, so a
  // partially bad record cannot NaN-poison the fragment either.
  p.storeyM = max(p.storeyM, 0.1);
  p.columnM = max(p.columnM, 0.1);
  p.coreW = max(p.coreW, 1.0);
  p.corePeriod = max(p.corePeriod, 1.0);
  p.tenantW = max(p.tenantW, 1.0);
  p.tenantH = max(p.tenantH, 1.0);
  p.groundStoreyM = max(p.groundStoreyM, 0.5);
  return p;
}

float facadeHourFactor(float group) {
  return group < 0.5 ? uHourFactor.x : (group < 1.5 ? uHourFactor.y : uHourFactor.z);
}

float fHash(float a, float b, float c) {
  vec3 p3 = fract(vec3(a, b, c) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// The transcription of isLit(). Four gates, same order, same constants.
// Core stripe, then floor, then tenancy, then the individual window.
float facadeLit(Facade p, float col, float floorIdx, float heightFade) {
  // No core on a house: it has no lift and no stair shaft, and two storeys of
  // stripe is correlation with nothing behind it. Mirrors isLit().
  if (p.house < 0.5) {
    float coreIdx = floor(col / p.coreW);
    if (abs(mod(coreIdx, p.corePeriod) - p.coreSlot) < 0.5) {
      return step(fHash(p.seed, 7.13, coreIdx), p.pCore);
    }
  }
  if (fHash(p.seed, 51.7, floorIdx) > p.pFloor * heightFade) return 0.0;
  float tb = floor(col / p.tenantW);
  float th = floor(floorIdx / p.tenantH);
  float hourF = facadeHourFactor(p.group);
  if (fHash(p.seed + tb * 0.977, 71.4, th) > p.pTenant * hourF) return 0.0;
  return step(fHash(p.seed + col * 0.131, 91.1, floorIdx), p.pCell);
}

// The closed form of the same thing, for the far field. See meanOccupancy().
float facadeMeanOccupancy(Facade p, float heightFade) {
  float coreFrac = p.house > 0.5 ? 0.0 : 1.0 / p.corePeriod;
  float hourF = facadeHourFactor(p.group);
  float body = p.pFloor * heightFade * min(1.0, p.pTenant * hourF) * p.pCell;
  return coreFrac * p.pCore + (1.0 - coreFrac) * body;
}
`;
