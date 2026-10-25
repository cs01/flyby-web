// WHICH KIND of building each footprint is: the archetype library and the rule
// that assigns it.
//
// Pure: no THREE, no DOM. test/archetype.check.ts gates the distribution per
// district and the neighbour coherence against this module, so the decision is
// made here, once per building, on the CPU, and the shader only reads it.
//
// The bar (docs/building-archetypes.md) is not a replica of each building. It is
// that every building looks like A real building of the right kind for its
// place. Five material families could not say that: a SoHo cast-iron loft, a
// Park Slope brownstone and a Midtown Deco tower were all "stone", and a block
// of Pacific Heights Victorians was brick because a hash said so.
//
// So each archetype below is a building TYPE, written down from what that type
// measures on real streets: floor-to-floor, window size and pitch, how deep the
// cornice projects, what the sash is, what the wall is laid in, what colours
// it comes in, and what is on its roof. The numbers are the ones a survey of
// that type finds, not tuned to look right, and where a number is a range it is
// the range the type spans.
//
// ASSIGNMENT. 86-90% of every pack is `building=yes` with no material, no date
// and no colour (measured: of the 1627 buildings in a Chelsea block query, 77
// carry building:material, 123 start_date, 133 building:colour). So the
// assignment leans on what IS on every record: height, footprint area, the
// tagged kind where there is one, and two things derived from the whole pack:
//
//   DISTRICT. The area-weighted mean height of the 300 m around a building says
//   downtown core, mid-rise, residential grid or industrial, and that is most
//   of what predicts a type. A 12 m building on a block of 12 m buildings is a
//   row house; the same 12 m among 150 m towers is a pre-war loft or a shop.
//
//   NEIGHBOUR COHERENCE. Buildings whose footprints touch (party walls) form a
//   cluster, and the archetype draw is made ONCE per cluster rather than once
//   per building. A terrace of row houses then shares a type and varies only
//   its colour, which is what a real block does: it does not alternate glass,
//   brick and stucco door by door.
//
// Where OSM DOES carry the evidence (the live path, which converts raw tags),
// building:material, start_date and building:colour override the guess.

import { Mat } from "./materials";
import type { BuildingTags } from "../data/citypack";

export type { BuildingTags };

// --- regions ----------------------------------------------------------------

/** Which survey applies. Generic falls back to the five material families. */
export enum Region {
  Generic = 0,
  NYC = 1,
  SF = 2,
  Chicago = 3,
}

export const REGION_NAMES = ["generic", "nyc", "sf", "chicago"] as const;

/**
 * The survey region a pack centre falls in. Boxes, generously drawn: the
 * Manhattan pack is 8 km round Midtown and takes in Brooklyn, Queens and the
 * Hudson waterfront of New Jersey, and all of that is the same building stock.
 * Emerald Hills (37.46) is south of the SF box on purpose: it is a Peninsula
 * suburb, not San Francisco.
 */
export function regionAt(lat: number, lon: number): Region {
  if (lat > 40.45 && lat < 40.95 && lon > -74.30 && lon < -73.65) return Region.NYC;
  if (lat > 37.69 && lat < 37.84 && lon > -122.53 && lon < -122.34) return Region.SF;
  if (lat > 41.62 && lat < 42.05 && lon > -87.95 && lon < -87.50) return Region.Chicago;
  return Region.Generic;
}

// --- districts --------------------------------------------------------------

export enum District {
  /** Downtown: towers and the pre-war office blocks between them. */
  Core = 0,
  /** Mid-rise mixed: apartment blocks, lofts, shops under flats. */
  Midrise = 1,
  /** The residential grid: row houses, walk-ups, two-flats, houses. */
  Residential = 2,
  /** Warehouses, sheds, yards. */
  Industrial = 3,
}

export const DISTRICT_NAMES = ["core", "midrise", "residential", "industrial"] as const;

/** Area-weighted mean height above which the 300 m neighbourhood is downtown. */
export const CORE_MEAN_H_M = 34;
/** And below which it is the residential grid. */
export const RESIDENTIAL_MEAN_H_M = 14;
/**
 * Share of the built area in big low sheds (over 2500 m2, under 20 m) above
 * which a low neighbourhood is industrial rather than residential. A US
 * warehouse district is mostly a few huge footprints; a residential grid is
 * hundreds of small ones, so even a couple of big-box stores in it stay under.
 */
export const INDUSTRIAL_SHED_SHARE = 0.45;

const DISTRICT_CELL_M = 100;

/** Minimal shape of a building as this module needs it. Matches citypack's Building. */
export interface FootprintLike {
  cx: number;
  cz: number;
  baseM: number;
  topM: number;
  kind: number;
  ring: Float32Array;
  tags?: BuildingTags;
  /** building:part group id; see citypack's Building.group. */
  group?: number;
}

export function footprintArea(ring: Float32Array): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return Math.abs(a / 2);
}

/**
 * District per building, from the 3 x 3 block of 100 m cells around it: the
 * area-weighted mean height and the share of built area in big low sheds.
 *
 * Area-weighted, not a plain mean, because a block of thirty 10 m row houses
 * with one 200 m tower on the corner is a residential block with a tower in
 * it, and a plain mean of heights would call it downtown.
 */
export function classifyDistricts(bs: readonly FootprintLike[], areas: Float64Array): Uint8Array {
  const cells = new Map<string, { a: number; ah: number; shed: number }>();
  const key = (ix: number, iz: number): string => `${ix},${iz}`;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const ix = Math.floor(b.cx / DISTRICT_CELL_M);
    const iz = Math.floor(b.cz / DISTRICT_CELL_M);
    const k = key(ix, iz);
    let c = cells.get(k);
    if (!c) { c = { a: 0, ah: 0, shed: 0 }; cells.set(k, c); }
    const h = b.topM - b.baseM;
    const a = areas[i];
    c.a += a;
    c.ah += a * h;
    if (a > 2500 && h < 20) c.shed += a;
  }
  const out = new Uint8Array(bs.length);
  const memo = new Map<string, District>();
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    const ix = Math.floor(b.cx / DISTRICT_CELL_M);
    const iz = Math.floor(b.cz / DISTRICT_CELL_M);
    const k = key(ix, iz);
    let d = memo.get(k);
    if (d === undefined) {
      let a = 0, ah = 0, shed = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const c = cells.get(key(ix + dx, iz + dz));
          if (c) { a += c.a; ah += c.ah; shed += c.shed; }
        }
      }
      const meanH = a > 0 ? ah / a : 0;
      d = meanH >= CORE_MEAN_H_M ? District.Core
        : shed / Math.max(a, 1) > INDUSTRIAL_SHED_SHARE && meanH < 20 ? District.Industrial
        : meanH < RESIDENTIAL_MEAN_H_M ? District.Residential
        : District.Midrise;
      memo.set(k, d);
    }
    out[i] = d;
  }
  return out;
}

// --- neighbour clusters -------------------------------------------------------

/** Two footprints closer than this share a party wall, metres. */
export const PARTY_WALL_M = 0.6;

/** Squared distance from point p to segment ab. */
function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px, ez = az + t * dz - pz;
  return ex * ex + ez * ez;
}

/** Some vertex of one ring lies within PARTY_WALL_M of an edge of the other. */
export function ringsTouch(a: Float32Array, b: Float32Array): boolean {
  const d2 = PARTY_WALL_M * PARTY_WALL_M;
  const test = (p: Float32Array, q: Float32Array): boolean => {
    const nq = q.length / 2;
    for (let v = 0; v < p.length; v += 2) {
      for (let k = 0, j = nq - 1; k < nq; j = k++) {
        if (segDist2(p[v], p[v + 1], q[j * 2], q[j * 2 + 1], q[k * 2], q[k * 2 + 1]) <= d2) return true;
      }
    }
    return false;
  };
  return test(a, b) || test(b, a);
}

/**
 * Union-find over footprints that touch: a vertex of one within PARTY_WALL_M
 * of an edge of the other, which is what a party wall is in OSM (the two rings
 * share the wall's two vertices, or one ends on the other's edge). Returns the
 * cluster root per building.
 *
 * Bounding boxes alone were tried first and are wrong in exactly the city that
 * matters: Manhattan's grid is turned 29 degrees, so the axis-aligned box of a
 * row of rotated rectangles overlaps the box of the row across the street, and
 * 13,745 buildings chained into one cluster. Boxes are kept as the broad phase.
 */
export function clusterNeighbours(bs: readonly FootprintLike[]): Int32Array {
  const n = bs.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const box = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = bs[i].ring;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let v = 0; v < r.length; v += 2) {
      if (r[v] < x0) x0 = r[v];
      if (r[v] > x1) x1 = r[v];
      if (r[v + 1] < z0) z0 = r[v + 1];
      if (r[v + 1] > z1) z1 = r[v + 1];
    }
    box[i * 4] = x0 - PARTY_WALL_M; box[i * 4 + 1] = x1 + PARTY_WALL_M;
    box[i * 4 + 2] = z0 - PARTY_WALL_M; box[i * 4 + 3] = z1 + PARTY_WALL_M;
  }
  const CELL = 40;
  const grid = new Map<number, number[]>();
  const gk = (ix: number, iz: number): number => (ix + 32768) * 65536 + (iz + 32768);
  for (let i = 0; i < n; i++) {
    const ix0 = Math.floor(box[i * 4] / CELL), ix1 = Math.floor(box[i * 4 + 1] / CELL);
    const iz0 = Math.floor(box[i * 4 + 2] / CELL), iz1 = Math.floor(box[i * 4 + 3] / CELL);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const k = gk(ix, iz);
        let list = grid.get(k);
        if (!list) { list = []; grid.set(k, list); }
        for (const j of list) {
          if (box[i * 4] <= box[j * 4 + 1] && box[j * 4] <= box[i * 4 + 1] &&
              box[i * 4 + 2] <= box[j * 4 + 3] && box[j * 4 + 2] <= box[i * 4 + 3] &&
              ringsTouch(bs[i].ring, bs[j].ring)) {
            const a = find(i), b = find(j);
            if (a !== b) parent[a < b ? b : a] = a < b ? a : b;
          }
        }
        list.push(i);
      }
    }
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}

// --- the archetype library -----------------------------------------------------

/** How a window opening is divided. Read by the shader's frame and mullion pass. */
export enum WindowStyle {
  /** One-over-one double-hung sash: a meeting rail at mid height. */
  Sash = 0,
  /** Paired casements or sliders: one vertical bar. */
  Casement = 1,
  /** Chicago window: a wide fixed light between two narrow sashes. */
  Chicago = 2,
  /** Curtain wall module: a transom low down, the spandrel glass below it. */
  Curtain = 3,
  /** Ribbon window: vertical mullions only, every module. */
  Ribbon = 4,
  /** Steel industrial sash: a grid of small panes. */
  Industrial = 5,
  /** A bay: three lights, the side two angled back. */
  Bay = 6,
  /** Pre-war double hung with muntins in the upper sash (six-over-one). */
  SashMuntin = 7,
}

export enum Interior {
  Apartment = 0,
  Office = 1,
  Loft = 2,
}

export enum RoofCover {
  /** Black built-up tar, the pre-war default. */
  Tar = 0,
  /** Aluminium roof coating over tar: the silver roofs all over NYC and Chicago. */
  Silver = 1,
  /** Ballasted gravel over membrane: offices, 1960-1990. */
  Gravel = 2,
  /** White TPO, the post-2000 cool-roof default. */
  WhiteMembrane = 3,
  /** Black EPDM rubber. */
  BlackMembrane = 4,
  /** Sedum tray green roof, post-2005 and mostly on new or civic buildings. */
  Green = 5,
  /** Concrete pavers on pedestals: a roof deck over the membrane. */
  Pavers = 6,
}

/** What a PITCHED roof is covered in. The shingle branch of the shader reads it. */
export enum PitchCover {
  /** Three-tab or architectural asphalt shingle, charcoal to weathered grey. */
  Asphalt = 0,
  /** Asphalt in the brown and red-brown blends. */
  AsphaltBrown = 1,
  /** Red clay barrel or Spanish tile: SF's Mediterranean houses. */
  ClayTile = 2,
  /** Slate, blue-grey, on pre-war houses and civic roofs. */
  Slate = 3,
  /** Copper gone to verdigris, on steeples, domes and bay turrets. */
  Copper = 4,
  /** Cedar shake weathered silver-brown. */
  Shake = 5,
}

/** Bits in the roof-feature byte. */
export const ROOF_SOLAR = 1;
export const ROOF_SKYLIGHTS = 2;
export const ROOF_DECK = 4;
/** Not a roof feature, but it rides the same byte: a fire escape on the front. */
export const FIRE_ESCAPE = 8;

/** A palette entry: a colour and the scan it is laid in. Picked together. */
export interface Swatch {
  /** Linear albedo of the wall, the mean the scan is rescaled to. */
  c: [number, number, number];
  m: Mat;
}

export interface Archetype {
  id: string;
  name: string;
  region: Region;
  /** FacadeFamily value (0 glass, 1 brick, 2 stucco, 3 concrete, 4 stone). */
  family: number;
  /** Years this type was built, for start_date when OSM has one. */
  era: [number, number];

  // --- where it occurs ---
  /** Multipliers by District: core, midrise, residential, industrial. */
  districts: [number, number, number, number];
  /** Height range the type spans, metres. Soft shoulders, zero well outside. */
  heightM: [number, number];
  /** Footprint area range, m2. Softer than height: footprints are noisy. */
  areaM2: [number, number];
  /** Multipliers by BuildingKind; absent kinds are 1. */
  kinds?: Partial<Record<number, number>>;
  /** Neighbourhoods where the type concentrates: lat, lon, radius km, multiplier. */
  zones?: [number, number, number, number][];
  /** Multiplier outside every zone, when zones are given. */
  zoneElse?: number;
  /** Base weight before any multiplier. */
  weight: number;

  // --- what it looks like ---
  palette: Swatch[];
  /** Sills, lintels, cornice and coping: usually the stone the wall is not. */
  trim: [number, number, number][];
  /** Sash and mullion paint or anodising. */
  frame: [number, number, number][];
  /** Linear tint of the glazing seen straight on. */
  glass: [number, number, number];
  glasses?: [number, number, number][];
  storeyM: number;
  columnM: number;
  /** Window inside a cell: x0, x1, y0, y1. */
  win: [number, number, number, number];
  glassFrac: number;
  relief: number;
  parapetM: number;
  /** Projecting cornice at the wall top, metres; 0 is none. */
  corniceM: number;
  /** Height of the stone sill and lintel bands, metres; 0 is none. */
  sillM: number;
  window: WindowStyle;
  /** Frame face width, metres. */
  frameM: number;
  /** Divisions across the opening for ribbon, industrial and muntin styles. */
  mullions: number;
  interior: Interior;
  /** Flat roof covers, drawn by hash. Repeats weight the draw. See ROOF_SURVEY. */
  roofs: RoofCover[];
  /** Pitched roof covers, when the footprint gets a tent. */
  pitched?: PitchCover[];
  /** Chance of a solar array on a flat roof. */
  solar?: number;
  /** Chance of a steel fire escape on the street front. */
  fireEscape?: number;
  /** Chance of a wooden water tank, on buildings 18-75 m tall. */
  tank: number;
  /** Weathering 0..1: how much soot, streaking and base grime. */
  age: number;
  /** How retail the ground floor is, before the per-building hash. */
  shopfront: number;
  /** A detached house: sparse openings, siding, a garage door. */
  house?: boolean;
  /**
   * Night occupancy group (0 home, 1 office, 2 shops and sheds). Defaults from
   * the interior: an apartment is a home, an office is an office, a loft is a
   * home (SoHo and SoMa lofts have been flats for forty years).
   */
  group?: number;
  /** Glazing reflectance, see FamilySpec.f0 in facade.ts. */
  f0: number;
  roughness: number;
}

/** sRGB 0..255 to linear, so a swatch can be written down as it was sampled. */
function lin(r: number, g: number, b: number): [number, number, number] {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [f(r), f(g), f(b)].map((v) => Number(v.toFixed(4))) as [number, number, number];
}

const sw = (m: Mat, r: number, g: number, b: number): Swatch => ({ c: lin(r, g, b), m });

// Shared trim and frame colours. Limestone trim is the sill and lintel stone on
// almost every pre-war masonry front in all three cities.
const LIMESTONE_TRIM = [lin(176, 166, 146), lin(160, 152, 136), lin(190, 182, 164)];
const PAINT_WHITE = lin(214, 211, 202);
const PAINT_BLACK = lin(30, 30, 30);
const PAINT_GREEN = lin(38, 58, 46);
const BRONZE = lin(62, 52, 40);
const ALUMINIUM = lin(150, 152, 150);
const CLEAR_GLASS = lin(40, 50, 56);

// Wall swatches, written in sRGB as a daylight-shade reading of each material
// (no direct sun, so close to albedo rather than a lit pixel). They come from
// the survey of each type and were checked against reference photographs, not
// sampled pixel by pixel from a photo set; docs/building-archetypes.md says
// which were measured and which are still open.
const NYC_RED_BRICK = [
  sw(Mat.OldBrick, 128, 62, 46), sw(Mat.OldBrick, 112, 58, 46), sw(Mat.RedBrick, 140, 72, 52),
  sw(Mat.RedBrick, 118, 66, 52), sw(Mat.BrownBrick, 104, 70, 58), sw(Mat.OldBrick, 96, 52, 42),
];
const NYC_PAINTED = [sw(Mat.PaintedBrick, 150, 146, 136), sw(Mat.PaintedBrick, 122, 118, 112), sw(Mat.PaintedBrick, 168, 150, 120)];
const BUFF_BRICK = [
  sw(Mat.BuffBrick, 176, 150, 112), sw(Mat.BuffBrick, 160, 132, 98), sw(Mat.BuffBrick, 188, 166, 128),
  sw(Mat.BuffBrick, 150, 118, 86),
];
const BROWNSTONE = [
  sw(Mat.Limestone, 104, 72, 58), sw(Mat.Limestone, 92, 66, 54), sw(Mat.Limestone, 118, 84, 66), sw(Mat.Limestone, 84, 60, 50),
];
const LIMESTONE = [sw(Mat.Limestone, 182, 172, 150), sw(Mat.Limestone, 168, 160, 142), sw(Mat.Limestone, 196, 188, 168)];
const GRANITE_BLOCK = [sw(Mat.BlockStone, 150, 146, 140), sw(Mat.BlockStone, 128, 124, 120)];
const CREAM_TERRACOTTA = [sw(Mat.Terracotta, 206, 196, 170), sw(Mat.Terracotta, 222, 216, 198), sw(Mat.Terracotta, 190, 176, 148)];
const BROWN_TERRACOTTA = [sw(Mat.Terracotta, 128, 92, 70)];
const CONCRETE = [sw(Mat.Precast, 160, 158, 150), sw(Mat.Precast, 140, 138, 132), sw(Mat.BoardConcrete, 150, 148, 140), sw(Mat.Precast, 176, 168, 152)];
// San Francisco paint, the range the Victorian and Edwardian rows actually
// carry: pale yellows, blues, greys, sage, salmon and whites, with the odd dark
// slate. Not the tourist-postcard saturation; most of a real row is muted.
const SF_PAINT = [
  // 206,186,140 and 84,104,96: a yellow and a green front on Pacific Heights,
  // measured off a CC BY photo in overcast shade and lifted out of the shade.
  sw(Mat.Siding, 206, 186, 140), sw(Mat.Siding, 168, 190, 204), sw(Mat.Siding, 222, 220, 210),
  sw(Mat.Siding, 84, 104, 96),
  sw(Mat.Siding, 176, 188, 160), sw(Mat.Siding, 214, 168, 150), sw(Mat.Siding, 128, 146, 168),
  sw(Mat.Siding, 196, 188, 172), sw(Mat.Siding, 96, 108, 100), sw(Mat.Siding, 212, 196, 170),
  sw(Mat.Siding, 186, 150, 160),
];
const SF_STUCCO = [
  sw(Mat.Stucco, 226, 216, 192), sw(Mat.Stucco, 214, 198, 168), sw(Mat.Stucco, 230, 228, 220),
  sw(Mat.Stucco, 218, 196, 180), sw(Mat.Stucco, 200, 210, 200), sw(Mat.Stucco, 206, 204, 196),
  sw(Mat.Stucco, 232, 214, 170),
];
const CHI_RED_BRICK = [
  sw(Mat.RedBrick, 132, 64, 46), sw(Mat.OldBrick, 116, 60, 46), sw(Mat.BrownBrick, 112, 74, 58),
  sw(Mat.RedBrick, 150, 84, 60),
];
// "Chicago common" brick: the soft yellow-brown brick the side walls and the
// whole of many workers' cottages are laid in.
const CHI_COMMON = [sw(Mat.BuffBrick, 158, 128, 92), sw(Mat.BuffBrick, 140, 112, 80)];
const GREYSTONE = [sw(Mat.Limestone, 158, 154, 142), sw(Mat.Limestone, 142, 138, 128)];
const GLASS_SPANDREL = [
  sw(Mat.MetalPanel, 70, 92, 104), sw(Mat.MetalPanel, 84, 104, 112), sw(Mat.MetalPanel, 60, 74, 88),
  sw(Mat.MetalPanel, 104, 116, 120), sw(Mat.MetalPanel, 54, 70, 66),
];
const METAL_GREY = [sw(Mat.MetalPanel, 150, 150, 146), sw(Mat.MetalPanel, 120, 122, 122), sw(Mat.MetalPanel, 176, 170, 156)];
// What a curtain wall is actually glazed in, as a body tint (the reflection
// takes the same hue on a coated glass; see the Fresnel term in buildings.ts).
// From the air over Midtown the towers are not one blue-grey: dark neutral
// grey and near-black, the blue of a 1980s and 2000s low-e coating, the
// blue-green of the MetLife and Bank of America generation, bronze and brown
// tints from the 1970s and 80s, and silver reflective. Read off the CC0
// Midtown aerial tools/verify-farcolour.ts is set against.
const CURTAIN_GLASS: [number, number, number][] = [
  lin(36, 40, 42), lin(26, 28, 30), lin(34, 52, 78), lin(40, 60, 86),
  lin(30, 66, 64), lin(38, 72, 66), lin(58, 46, 36), lin(70, 74, 76),
];
const MIES_STEEL = [sw(Mat.MetalPanel, 22, 22, 22), sw(Mat.MetalPanel, 30, 26, 22)];
const HOUSE_SIDING = [
  sw(Mat.Siding, 216, 214, 204), sw(Mat.Siding, 190, 184, 166), sw(Mat.Siding, 170, 178, 176),
  sw(Mat.Siding, 204, 192, 160), sw(Mat.Siding, 150, 160, 168),
];

const COMMON = {
  f0Punched: 0.05,
};

// Region lists. Every number with a source in docs/building-archetypes.md.
export const ARCHETYPES: Archetype[] = [
  // ======================= New York =======================
  {
    id: "nyc-walkup", name: "pre-war brick walk-up tenement", region: Region.NYC, family: 1, era: [1870, 1925],
    districts: [0.35, 1.0, 1.0, 0.2], heightM: [11, 24], areaM2: [70, 700], weight: 1.0,
    kinds: { 1: 1.3, 2: 0.6, 6: 0 },
    palette: [...NYC_RED_BRICK, ...NYC_PAINTED], trim: LIMESTONE_TRIM, frame: [PAINT_WHITE, PAINT_BLACK, PAINT_GREEN, lin(180, 168, 140)],
    glass: CLEAR_GLASS,
    // 25 ft lot, four windows across: 7.6 m / 4 = 1.9 m pitch; 3.15 m floor to
    // floor; a 36 x 66 in sash is 0.91 x 1.68 m.
    storeyM: 3.15, columnM: 1.95, win: [0.27, 0.73, 0.24, 0.78], glassFrac: 0.24,
    relief: 0.8, parapetM: 0.9, corniceM: 0.75, sillM: 0.14, window: WindowStyle.Sash, frameM: 0.07, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Silver, RoofCover.Silver, RoofCover.Tar, RoofCover.BlackMembrane],
    tank: 0.35, age: 0.85, shopfront: 0.55, f0: COMMON.f0Punched, roughness: 0.86,
    // The 1901 Tenement House Act required one on every walk-up front without
    // a fireproof stair, and most of them are still there.
    fireEscape: 0.8,
  },
  {
    id: "nyc-brownstone", name: "brownstone or brick row house", region: Region.NYC, family: 4, era: [1850, 1900],
    districts: [0.05, 0.45, 1.0, 0.0], heightM: [8, 18], areaM2: [55, 280], weight: 1.0,
    kinds: { 1: 1.5, 2: 0.3, 3: 0, 6: 0 },
    zones: [
      [40.672, -73.977, 1.6, 3.0], [40.690, -73.993, 1.3, 3.0], [40.688, -73.968, 1.2, 3.0],
      [40.812, -73.945, 1.6, 2.5], [40.785, -73.975, 1.2, 1.6], [40.745, -74.030, 1.0, 2.0],
      [40.735, -74.003, 1.0, 1.6], [40.682, -73.940, 1.5, 2.0],
    ],
    zoneElse: 0.35,
    palette: [...BROWNSTONE, ...BROWNSTONE, sw(Mat.RedBrick, 132, 70, 52), sw(Mat.OldBrick, 120, 64, 50)],
    trim: [lin(120, 90, 72), lin(150, 140, 124)], frame: [PAINT_WHITE, PAINT_BLACK, lin(70, 50, 38)],
    glass: CLEAR_GLASS,
    // 20 ft frontage, three bays: 6.1 / 3 = 2.0 m; a parlour floor at 3.6 m and
    // bedrooms at 3.2 m average 3.4; tall 1.0 x 2.0 m parlour windows.
    storeyM: 3.4, columnM: 2.0, win: [0.26, 0.74, 0.22, 0.80], glassFrac: 0.26,
    relief: 0.85, parapetM: 0.5, corniceM: 0.6, sillM: 0.12, window: WindowStyle.Sash, frameM: 0.08, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.Silver, RoofCover.BlackMembrane],
    tank: 0, age: 0.7, shopfront: 0.04, f0: COMMON.f0Punched, roughness: 0.8,
  },
  {
    id: "nyc-prewar-apt", name: "pre-war elevator apartment block", region: Region.NYC, family: 1, era: [1905, 1940],
    districts: [0.5, 1.0, 0.6, 0.1], heightM: [24, 60], areaM2: [350, 5000], weight: 1.0,
    kinds: { 1: 1.4, 2: 0.5, 3: 0.2 },
    palette: [...BUFF_BRICK, ...NYC_RED_BRICK.slice(0, 3), sw(Mat.BrownBrick, 118, 88, 66)], trim: LIMESTONE_TRIM,
    frame: [PAINT_WHITE, PAINT_BLACK, BRONZE], glass: CLEAR_GLASS,
    storeyM: 3.05, columnM: 2.2, win: [0.28, 0.72, 0.21, 0.78], glassFrac: 0.26,
    relief: 0.7, parapetM: 1.1, corniceM: 0.5, sillM: 0.12, window: WindowStyle.SashMuntin, frameM: 0.07, mullions: 3,
    interior: Interior.Apartment, roofs: [RoofCover.Silver, RoofCover.Tar, RoofCover.BlackMembrane],
    tank: 0.65, age: 0.6, shopfront: 0.35, f0: COMMON.f0Punched, roughness: 0.84,
    fireEscape: 0.3,
  },
  {
    id: "nyc-loft", name: "cast-iron or masonry loft", region: Region.NYC, family: 4, era: [1860, 1925],
    districts: [0.6, 1.0, 0.3, 0.8], heightM: [15, 60], areaM2: [180, 3000], weight: 0.8,
    kinds: { 2: 1.5, 3: 1.3, 1: 0.7 },
    zones: [
      [40.722, -74.003, 1.1, 3.5], [40.742, -73.992, 1.0, 2.2], [40.752, -73.991, 0.8, 2.2],
      [40.703, -73.989, 0.7, 2.5], [40.716, -73.960, 1.2, 1.6], [40.740, -73.957, 0.9, 1.6],
    ],
    zoneElse: 0.35,
    palette: [
      // The Garment District and Flatiron lofts from the air: buff and tan
      // brick, cream terracotta and limestone, red brick. Two grey stones
      // (170,170,164 and a green-grey 120,132,124) were here and were most
      // of why the loft blocks read as one grey from 600 m.
      sw(Mat.Limestone, 200, 194, 176), sw(Mat.Limestone, 214, 210, 198), BUFF_BRICK[0], BUFF_BRICK[3],
      CREAM_TERRACOTTA[0], ...NYC_RED_BRICK.slice(0, 3),
    ],
    trim: [lin(190, 186, 174), lin(150, 150, 146)], frame: [PAINT_BLACK, PAINT_WHITE, PAINT_GREEN], glass: CLEAR_GLASS,
    // A loft is all window: 4.1 m floors and 1.8 x 2.9 m sash between thin piers.
    storeyM: 4.1, columnM: 2.9, win: [0.18, 0.82, 0.14, 0.86], glassFrac: 0.45,
    relief: 0.8, parapetM: 0.9, corniceM: 0.85, sillM: 0.10, window: WindowStyle.Sash, frameM: 0.09, mullions: 1,
    interior: Interior.Loft, roofs: [RoofCover.Tar, RoofCover.Silver, RoofCover.BlackMembrane],
    tank: 0.6, age: 0.75, shopfront: 0.85, f0: COMMON.f0Punched, roughness: 0.78,
    fireEscape: 0.6,
  },
  {
    id: "nyc-deco-tower", name: "Art Deco setback tower", region: Region.NYC, family: 4, era: [1924, 1940],
    districts: [1.0, 0.6, 0.05, 0.0], heightM: [70, 330], areaM2: [700, 9000], weight: 0.35,
    kinds: { 2: 1.3, 6: 1.0, 1: 0.5 },
    palette: [...BUFF_BRICK, sw(Mat.Limestone, 188, 178, 156), sw(Mat.Limestone, 170, 160, 140)],
    trim: LIMESTONE_TRIM, frame: [BRONZE, PAINT_BLACK], glass: CLEAR_GLASS,
    // Paired windows between continuous piers, 1.7 m on centres, and a dark
    // recessed spandrel: the vertical striping is the Deco signature.
    storeyM: 3.7, columnM: 1.7, win: [0.24, 0.76, 0.18, 0.80], glassFrac: 0.30,
    relief: 0.9, parapetM: 1.6, corniceM: 0, sillM: 0, window: WindowStyle.SashMuntin, frameM: 0.06, mullions: 2,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.Gravel],
    tank: 0.12, age: 0.6, shopfront: 0.6, f0: COMMON.f0Punched, roughness: 0.75,
  },
  {
    id: "nyc-prewar-office", name: "pre-war limestone office block", region: Region.NYC, family: 4, era: [1895, 1931],
    districts: [1.0, 0.7, 0.05, 0.05], heightM: [35, 160], areaM2: [400, 6000], weight: 0.9,
    kinds: { 2: 1.4, 5: 1.4, 6: 0.8, 1: 0.4 },
    palette: [...LIMESTONE, ...GRANITE_BLOCK, BUFF_BRICK[0], BUFF_BRICK[2]], trim: LIMESTONE_TRIM,
    frame: [PAINT_BLACK, BRONZE, PAINT_WHITE], glass: CLEAR_GLASS,
    storeyM: 3.9, columnM: 2.0, win: [0.23, 0.77, 0.20, 0.82], glassFrac: 0.32,
    relief: 0.85, parapetM: 1.2, corniceM: 1.0, sillM: 0.12, window: WindowStyle.Sash, frameM: 0.07, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.Gravel, RoofCover.Silver],
    tank: 0.35, age: 0.65, shopfront: 0.8, f0: COMMON.f0Punched, roughness: 0.72,
  },
  {
    id: "nyc-intl-slab", name: "1960s glass-and-spandrel slab", region: Region.NYC, family: 3, era: [1952, 1978],
    districts: [1.0, 0.5, 0.05, 0.05], heightM: [40, 230], areaM2: [700, 14000], weight: 1.0,
    kinds: { 2: 1.4, 6: 1.0, 1: 0.4 },
    palette: [...GLASS_SPANDREL, ...METAL_GREY], trim: [ALUMINIUM], frame: [ALUMINIUM, lin(60, 60, 62)],
    glass: lin(46, 62, 66),
    storeyM: 3.7, columnM: 1.5, win: [0.05, 0.95, 0.36, 0.92], glassFrac: 0.62,
    relief: 0.15, parapetM: 1.0, corniceM: 0, sillM: 0, window: WindowStyle.Ribbon, frameM: 0.06, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Gravel, RoofCover.BlackMembrane],
    tank: 0, age: 0.35, shopfront: 0.7, f0: 0.14, roughness: 0.3,
  },
  {
    id: "nyc-white-brick", name: "post-war white brick apartment tower", region: Region.NYC, family: 1, era: [1950, 1975],
    districts: [0.4, 1.0, 0.6, 0.0], heightM: [35, 110], areaM2: [500, 5000], weight: 0.7,
    kinds: { 1: 1.5, 2: 0.4 },
    palette: [sw(Mat.PaintedBrick, 214, 210, 198), sw(Mat.PaintedBrick, 196, 190, 176), sw(Mat.BuffBrick, 200, 184, 156), sw(Mat.PaintedBrick, 178, 172, 160)],
    trim: [ALUMINIUM, lin(190, 186, 176)], frame: [ALUMINIUM], glass: CLEAR_GLASS,
    storeyM: 2.8, columnM: 3.0, win: [0.20, 0.80, 0.26, 0.76], glassFrac: 0.30,
    relief: 0.45, parapetM: 1.1, corniceM: 0, sillM: 0, window: WindowStyle.Casement, frameM: 0.06, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.BlackMembrane, RoofCover.Silver],
    tank: 0.2, age: 0.45, shopfront: 0.3, f0: COMMON.f0Punched, roughness: 0.6,
  },
  {
    id: "nyc-projects", name: "public housing brick tower", region: Region.NYC, family: 1, era: [1940, 1970],
    districts: [0.05, 0.6, 1.0, 0.1], heightM: [18, 65], areaM2: [450, 3000], weight: 0.45,
    kinds: { 1: 1.5, 2: 0.2 },
    palette: [sw(Mat.RedBrick, 126, 66, 50), sw(Mat.BrownBrick, 110, 76, 62), sw(Mat.RedBrick, 140, 80, 60)],
    trim: [lin(130, 126, 118)], frame: [ALUMINIUM, PAINT_BLACK], glass: CLEAR_GLASS,
    storeyM: 2.75, columnM: 3.2, win: [0.26, 0.74, 0.28, 0.72], glassFrac: 0.22,
    relief: 0.4, parapetM: 1.0, corniceM: 0, sillM: 0, window: WindowStyle.Casement, frameM: 0.06, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.BlackMembrane],
    tank: 0, age: 0.6, shopfront: 0.02, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "nyc-house", name: "outer-borough frame or brick house", region: Region.NYC, family: 1, era: [1900, 1990],
    districts: [0.0, 0.3, 1.0, 0.2], heightM: [4, 11], areaM2: [45, 260], weight: 0.9,
    kinds: { 1: 1.6, 2: 0.2, 3: 0.1 },
    palette: [...HOUSE_SIDING, sw(Mat.RedBrick, 140, 76, 58), sw(Mat.BrownBrick, 122, 92, 76)],
    trim: [PAINT_WHITE], frame: [PAINT_WHITE], glass: CLEAR_GLASS,
    storeyM: 2.85, columnM: 4.3, win: [0.23, 0.77, 0.30, 0.80], glassFrac: 0.2,
    relief: 0.3, parapetM: 0.4, corniceM: 0, sillM: 0, window: WindowStyle.Sash, frameM: 0.06, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.BlackMembrane],
    tank: 0, age: 0.35, shopfront: 0.1, house: true, f0: COMMON.f0Punched, roughness: 0.8,
  },

  // ======================= San Francisco =======================
  {
    id: "sf-victorian", name: "Victorian timber row house", region: Region.SF, family: 2, era: [1870, 1906],
    districts: [0.0, 0.4, 1.0, 0.05], heightM: [6, 13.5], areaM2: [60, 320], weight: 1.0,
    kinds: { 1: 1.4, 2: 0.4, 3: 0, 6: 0 },
    zones: [[37.775, -122.435, 2.0, 2.2], [37.758, -122.420, 1.5, 2.0], [37.790, -122.433, 1.0, 1.8], [37.797, -122.415, 1.0, 1.4]],
    zoneElse: 0.55,
    palette: SF_PAINT, trim: [PAINT_WHITE, lin(232, 226, 210), lin(70, 70, 66), lin(150, 70, 60)],
    frame: [PAINT_WHITE, lin(232, 226, 210)], glass: CLEAR_GLASS,
    // A 25 ft lot, a three-light bay of 0.9 x 2.1 m sashes on 3.6 m floors
    // (Victorian ceilings are 11 to 12 ft).
    storeyM: 3.5, columnM: 1.75, win: [0.22, 0.78, 0.20, 0.84], glassFrac: 0.28,
    relief: 0.7, parapetM: 0.8, corniceM: 0.55, sillM: 0.10, window: WindowStyle.Bay, frameM: 0.08, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.Silver, RoofCover.BlackMembrane],
    tank: 0, age: 0.3, shopfront: 0.12, f0: COMMON.f0Punched, roughness: 0.8,
  },
  {
    id: "sf-edwardian", name: "Edwardian flats", region: Region.SF, family: 2, era: [1906, 1925],
    districts: [0.05, 0.7, 1.0, 0.05], heightM: [9, 17], areaM2: [130, 600], weight: 0.9,
    kinds: { 1: 1.4, 2: 0.6 },
    palette: [...SF_PAINT.slice(0, 7), ...SF_STUCCO.slice(0, 3)], trim: [PAINT_WHITE, lin(232, 226, 210)],
    frame: [PAINT_WHITE], glass: CLEAR_GLASS,
    storeyM: 3.25, columnM: 1.85, win: [0.20, 0.80, 0.22, 0.82], glassFrac: 0.3,
    relief: 0.65, parapetM: 0.8, corniceM: 0.5, sillM: 0.08, window: WindowStyle.Bay, frameM: 0.08, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.Silver],
    tank: 0, age: 0.3, shopfront: 0.25, f0: COMMON.f0Punched, roughness: 0.8,
    fireEscape: 0.25,
  },
  {
    id: "sf-stucco-apt", name: "1920s stucco apartment block", region: Region.SF, family: 2, era: [1920, 1940],
    districts: [0.15, 1.0, 0.9, 0.05], heightM: [9, 24], areaM2: [200, 1800], weight: 0.9,
    kinds: { 1: 1.3, 2: 0.6 },
    palette: SF_STUCCO, trim: [lin(232, 226, 210), lin(176, 120, 96)], frame: [PAINT_WHITE, PAINT_BLACK, lin(70, 90, 80)],
    glass: CLEAR_GLASS,
    storeyM: 3.0, columnM: 2.6, win: [0.25, 0.75, 0.24, 0.80], glassFrac: 0.26,
    relief: 0.6, parapetM: 0.9, corniceM: 0.25, sillM: 0, window: WindowStyle.SashMuntin, frameM: 0.06, mullions: 3,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.WhiteMembrane, RoofCover.Silver],
    tank: 0, age: 0.35, shopfront: 0.2, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "sf-marina", name: "Marina stucco house over garage", region: Region.SF, family: 2, era: [1924, 1945],
    districts: [0.0, 0.3, 1.0, 0.05], heightM: [6, 12], areaM2: [70, 330], weight: 0.6,
    kinds: { 1: 1.4, 2: 0.3 },
    zones: [[37.802, -122.437, 1.1, 4.0], [37.780, -122.478, 2.6, 3.0], [37.760, -122.475, 2.0, 2.5]],
    zoneElse: 0.3,
    palette: SF_STUCCO, trim: [lin(232, 226, 210), lin(176, 120, 96)], frame: [PAINT_WHITE, PAINT_BLACK],
    glass: CLEAR_GLASS,
    storeyM: 3.0, columnM: 2.9, win: [0.20, 0.80, 0.24, 0.80], glassFrac: 0.28,
    relief: 0.55, parapetM: 0.6, corniceM: 0.2, sillM: 0, window: WindowStyle.SashMuntin, frameM: 0.06, mullions: 3,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.WhiteMembrane],
    tank: 0, age: 0.25, shopfront: 0.02, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "sf-postwar-apt", name: "post-war stucco box apartments", region: Region.SF, family: 2, era: [1950, 1975],
    districts: [0.1, 0.8, 0.8, 0.1], heightM: [8, 26], areaM2: [180, 1600], weight: 0.6,
    kinds: { 1: 1.2, 2: 0.6 },
    palette: [...SF_STUCCO, sw(Mat.Siding, 200, 196, 186)], trim: [ALUMINIUM], frame: [ALUMINIUM], glass: CLEAR_GLASS,
    storeyM: 2.8, columnM: 3.2, win: [0.18, 0.82, 0.28, 0.74], glassFrac: 0.3,
    relief: 0.35, parapetM: 0.7, corniceM: 0, sillM: 0, window: WindowStyle.Casement, frameM: 0.05, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.WhiteMembrane, RoofCover.Gravel],
    tank: 0, age: 0.3, shopfront: 0.15, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "sf-house", name: "west-side stucco or shingle house", region: Region.SF, family: 2, era: [1925, 1960],
    districts: [0.0, 0.2, 1.0, 0.1], heightM: [4, 9], areaM2: [60, 260], weight: 0.5,
    kinds: { 1: 1.4, 2: 0.2 },
    palette: [...SF_STUCCO, ...HOUSE_SIDING.slice(0, 3)], trim: [PAINT_WHITE], frame: [PAINT_WHITE], glass: CLEAR_GLASS,
    storeyM: 2.85, columnM: 4.3, win: [0.23, 0.77, 0.30, 0.80], glassFrac: 0.2,
    relief: 0.3, parapetM: 0.4, corniceM: 0, sillM: 0, window: WindowStyle.SashMuntin, frameM: 0.06, mullions: 3,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.WhiteMembrane],
    tank: 0, age: 0.25, shopfront: 0.05, house: true, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "sf-downtown-prewar", name: "downtown terracotta and granite office", region: Region.SF, family: 4, era: [1906, 1931],
    districts: [1.0, 0.6, 0.05, 0.05], heightM: [20, 110], areaM2: [250, 4500], weight: 0.9,
    kinds: { 2: 1.4, 5: 1.4, 1: 0.5 },
    palette: [...CREAM_TERRACOTTA, ...GRANITE_BLOCK, BUFF_BRICK[0], ...BROWN_TERRACOTTA], trim: [lin(206, 198, 176), lin(150, 146, 138)],
    frame: [PAINT_BLACK, BRONZE, PAINT_WHITE], glass: CLEAR_GLASS,
    storeyM: 3.8, columnM: 2.1, win: [0.22, 0.78, 0.20, 0.82], glassFrac: 0.32,
    relief: 0.8, parapetM: 1.2, corniceM: 0.9, sillM: 0.1, window: WindowStyle.Sash, frameM: 0.07, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.Gravel],
    tank: 0, age: 0.5, shopfront: 0.8, f0: COMMON.f0Punched, roughness: 0.75,
  },
  {
    id: "sf-soma-warehouse", name: "SoMa brick or concrete warehouse", region: Region.SF, family: 1, era: [1906, 1935],
    districts: [0.2, 0.8, 0.2, 1.0], heightM: [7, 30], areaM2: [350, 9000], weight: 0.8,
    kinds: { 3: 1.6, 2: 1.0, 1: 0.5 },
    zones: [[37.776, -122.402, 1.6, 2.5], [37.765, -122.395, 1.2, 2.0]],
    zoneElse: 0.6,
    palette: [...CHI_RED_BRICK.slice(0, 3), sw(Mat.Precast, 196, 188, 170), sw(Mat.PaintedBrick, 180, 176, 166), sw(Mat.BoardConcrete, 168, 164, 154)],
    trim: [lin(180, 174, 160)], frame: [PAINT_BLACK, lin(90, 96, 96)], glass: CLEAR_GLASS,
    storeyM: 4.2, columnM: 3.6, win: [0.14, 0.86, 0.18, 0.84], glassFrac: 0.42,
    relief: 0.6, parapetM: 1.0, corniceM: 0.3, sillM: 0.1, window: WindowStyle.Industrial, frameM: 0.05, mullions: 4,
    interior: Interior.Loft, roofs: [RoofCover.Tar, RoofCover.Gravel, RoofCover.WhiteMembrane],
    tank: 0, age: 0.7, shopfront: 0.3, f0: COMMON.f0Punched, roughness: 0.85,
  },

  // ======================= Chicago =======================
  {
    id: "chi-school", name: "Chicago School terracotta office", region: Region.Chicago, family: 4, era: [1885, 1915],
    districts: [1.0, 0.6, 0.02, 0.1], heightM: [28, 100], areaM2: [350, 5000], weight: 1.0,
    kinds: { 2: 1.4, 5: 1.2, 1: 0.4 },
    palette: [...CREAM_TERRACOTTA, ...BROWN_TERRACOTTA, BUFF_BRICK[1], sw(Mat.Terracotta, 150, 146, 138)],
    trim: [lin(206, 198, 176)], frame: [PAINT_BLACK, BRONZE, PAINT_WHITE], glass: CLEAR_GLASS,
    // One structural bay per opening: a 20 ft bay holding a Chicago window, a
    // fixed light about twice the width of each sash beside it.
    storeyM: 3.9, columnM: 5.6, win: [0.08, 0.92, 0.16, 0.86], glassFrac: 0.55,
    relief: 0.75, parapetM: 1.2, corniceM: 1.0, sillM: 0.1, window: WindowStyle.Chicago, frameM: 0.08, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.Gravel],
    tank: 0.1, age: 0.75, shopfront: 0.85, f0: COMMON.f0Punched, roughness: 0.7,
  },
  {
    id: "chi-mies", name: "Miesian black steel and bronze glass", region: Region.Chicago, family: 0, era: [1950, 1978],
    districts: [1.0, 0.6, 0.05, 0.0], heightM: [35, 360], areaM2: [700, 12000], weight: 0.9,
    kinds: { 2: 1.4, 6: 1.2, 1: 0.7 },
    palette: MIES_STEEL, trim: [lin(24, 24, 24)], frame: [lin(22, 22, 22)], glass: lin(44, 38, 30),
    // The 5 ft (1.52 m) module with an I-beam mullion on every line.
    storeyM: 3.7, columnM: 1.55, win: [0.06, 0.94, 0.06, 0.92], glassFrac: 0.86,
    relief: 0.25, parapetM: 1.2, corniceM: 0, sillM: 0, window: WindowStyle.Curtain, frameM: 0.10, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Gravel, RoofCover.BlackMembrane],
    tank: 0, age: 0.3, shopfront: 0.75, f0: 0.12, roughness: 0.05,
  },
  {
    id: "chi-deco", name: "Art Deco limestone tower", region: Region.Chicago, family: 4, era: [1924, 1935],
    districts: [1.0, 0.5, 0.02, 0.0], heightM: [55, 260], areaM2: [700, 8000], weight: 0.6,
    kinds: { 2: 1.3, 6: 1.0, 5: 1.2 },
    palette: [...LIMESTONE, sw(Mat.Limestone, 160, 156, 146)], trim: LIMESTONE_TRIM, frame: [BRONZE, PAINT_BLACK], glass: CLEAR_GLASS,
    storeyM: 3.8, columnM: 1.8, win: [0.25, 0.75, 0.20, 0.80], glassFrac: 0.3,
    relief: 0.9, parapetM: 1.6, corniceM: 0, sillM: 0, window: WindowStyle.SashMuntin, frameM: 0.06, mullions: 2,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.Gravel],
    tank: 0.05, age: 0.6, shopfront: 0.6, f0: COMMON.f0Punched, roughness: 0.72,
  },
  {
    id: "chi-concrete", name: "1970s concrete frame tower", region: Region.Chicago, family: 3, era: [1962, 1985],
    districts: [0.8, 1.0, 0.3, 0.1], heightM: [28, 200], areaM2: [450, 7000], weight: 0.8,
    kinds: { 1: 1.2, 2: 1.0 },
    palette: CONCRETE, trim: [lin(170, 166, 158)], frame: [ALUMINIUM, BRONZE], glass: lin(44, 52, 56),
    storeyM: 3.0, columnM: 3.0, win: [0.14, 0.86, 0.24, 0.78], glassFrac: 0.45,
    relief: 0.6, parapetM: 1.1, corniceM: 0, sillM: 0, window: WindowStyle.Casement, frameM: 0.06, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Gravel, RoofCover.BlackMembrane, RoofCover.WhiteMembrane],
    tank: 0, age: 0.5, shopfront: 0.4, f0: 0.14, roughness: 0.62,
  },
  {
    id: "chi-courtyard", name: "courtyard apartment building", region: Region.Chicago, family: 1, era: [1905, 1930],
    districts: [0.05, 0.7, 1.0, 0.0], heightM: [9, 17], areaM2: [450, 3500], weight: 1.0,
    kinds: { 1: 1.5, 2: 0.4 },
    palette: [...CHI_RED_BRICK, ...CHI_COMMON], trim: LIMESTONE_TRIM, frame: [PAINT_WHITE, PAINT_BLACK, BRONZE], glass: CLEAR_GLASS,
    storeyM: 3.1, columnM: 2.3, win: [0.26, 0.74, 0.22, 0.80], glassFrac: 0.26,
    relief: 0.7, parapetM: 1.0, corniceM: 0.4, sillM: 0.12, window: WindowStyle.SashMuntin, frameM: 0.07, mullions: 3,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.Silver],
    tank: 0, age: 0.6, shopfront: 0.05, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "chi-two-flat", name: "greystone or brick two-flat", region: Region.Chicago, family: 4, era: [1890, 1925],
    districts: [0.0, 0.4, 1.0, 0.05], heightM: [6.5, 14], areaM2: [80, 320], weight: 1.0,
    kinds: { 1: 1.5, 2: 0.4 },
    palette: [...GREYSTONE, ...CHI_RED_BRICK, ...CHI_COMMON], trim: LIMESTONE_TRIM, frame: [PAINT_WHITE, PAINT_BLACK], glass: CLEAR_GLASS,
    storeyM: 3.4, columnM: 2.0, win: [0.26, 0.74, 0.20, 0.82], glassFrac: 0.26,
    relief: 0.75, parapetM: 0.8, corniceM: 0.45, sillM: 0.12, window: WindowStyle.Sash, frameM: 0.07, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.Silver],
    tank: 0, age: 0.65, shopfront: 0.05, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "chi-cottage", name: "brick bungalow or workers' cottage", region: Region.Chicago, family: 1, era: [1880, 1940],
    districts: [0.0, 0.2, 1.0, 0.1], heightM: [3, 8.5], areaM2: [45, 230], weight: 0.9,
    kinds: { 1: 1.4, 2: 0.3 },
    palette: [...CHI_RED_BRICK, ...CHI_COMMON, ...HOUSE_SIDING.slice(0, 3)], trim: LIMESTONE_TRIM, frame: [PAINT_WHITE], glass: CLEAR_GLASS,
    storeyM: 2.9, columnM: 4.3, win: [0.23, 0.77, 0.30, 0.80], glassFrac: 0.2,
    relief: 0.4, parapetM: 0.5, corniceM: 0, sillM: 0.1, window: WindowStyle.Sash, frameM: 0.06, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.Tar, RoofCover.BlackMembrane],
    tank: 0, age: 0.5, shopfront: 0.05, house: true, f0: COMMON.f0Punched, roughness: 0.85,
  },

  // ======================= shared by all three surveyed cities =======================
  {
    id: "us-glass-tower", name: "post-1985 curtain-wall tower", region: Region.Generic, family: 0, era: [1985, 2030],
    districts: [1.0, 0.45, 0.04, 0.05], heightM: [55, 560], areaM2: [400, 16000], weight: 1.4,
    kinds: { 6: 1.5, 2: 1.3, 1: 0.7 },
    palette: GLASS_SPANDREL, trim: [lin(150, 156, 160)], frame: [lin(150, 156, 160), lin(70, 76, 80)], glass: lin(40, 56, 66), glasses: CURTAIN_GLASS,
    storeyM: 4.0, columnM: 1.5, win: [0.04, 0.96, 0.08, 0.95], glassFrac: 0.92,
    relief: 0.1, parapetM: 0.9, corniceM: 0, sillM: 0, window: WindowStyle.Curtain, frameM: 0.05, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Gravel, RoofCover.WhiteMembrane],
    tank: 0, age: 0.1, shopfront: 0.7, f0: 0.22, roughness: 0.06,
  },
  {
    id: "us-midrise-office", name: "1980-2010 mid-rise office", region: Region.Generic, family: 3, era: [1975, 2015],
    districts: [0.8, 1.0, 0.15, 0.3], heightM: [16, 95], areaM2: [500, 12000], weight: 0.7,
    kinds: { 2: 1.5, 6: 0.8, 1: 0.4 },
    palette: [...CONCRETE, sw(Mat.Granite, 150, 120, 110), sw(Mat.Granite, 120, 116, 112), ...METAL_GREY.slice(0, 2)],
    trim: [ALUMINIUM], frame: [ALUMINIUM, lin(50, 54, 56)], glass: lin(40, 54, 60),
    storeyM: 3.9, columnM: 1.6, win: [0.06, 0.94, 0.30, 0.90], glassFrac: 0.6,
    relief: 0.3, parapetM: 1.1, corniceM: 0, sillM: 0, window: WindowStyle.Ribbon, frameM: 0.06, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Gravel, RoofCover.WhiteMembrane, RoofCover.BlackMembrane],
    tank: 0, age: 0.25, shopfront: 0.6, f0: 0.14, roughness: 0.4,
  },
  {
    id: "us-residential-tower", name: "post-2000 glass and panel condo tower", region: Region.Generic, family: 0, era: [1998, 2030],
    districts: [1.0, 0.8, 0.15, 0.1], heightM: [45, 450], areaM2: [400, 6000], weight: 0.45,
    kinds: { 1: 1.6, 2: 0.6, 6: 1.0 },
    palette: [...GLASS_SPANDREL.slice(0, 3), sw(Mat.MetalPanel, 190, 188, 182), sw(Mat.Precast, 200, 196, 186)],
    trim: [lin(190, 190, 186)], frame: [lin(120, 124, 126), lin(60, 62, 64)], glass: lin(46, 58, 64), glasses: CURTAIN_GLASS,
    storeyM: 3.2, columnM: 1.6, win: [0.05, 0.95, 0.06, 0.94], glassFrac: 0.8,
    relief: 0.15, parapetM: 1.1, corniceM: 0, sillM: 0, window: WindowStyle.Curtain, frameM: 0.06, mullions: 1,
    interior: Interior.Apartment, roofs: [RoofCover.WhiteMembrane, RoofCover.Gravel],
    tank: 0, age: 0.1, shopfront: 0.6, f0: 0.18, roughness: 0.08,
  },
  {
    id: "us-warehouse", name: "industrial shed or warehouse", region: Region.Generic, family: 3, era: [1920, 2010],
    districts: [0.1, 0.4, 0.15, 1.0], heightM: [3.5, 16], areaM2: [500, 60000], weight: 0.8,
    kinds: { 3: 2.2, 2: 0.8, 1: 0.1 },
    palette: [sw(Mat.Precast, 176, 170, 158), sw(Mat.Precast, 150, 148, 142), ...METAL_GREY, sw(Mat.RedBrick, 132, 72, 54), sw(Mat.BoardConcrete, 168, 162, 150)],
    trim: [lin(150, 148, 140)], frame: [lin(90, 96, 96), PAINT_BLACK], glass: CLEAR_GLASS,
    storeyM: 4.6, columnM: 6.0, win: [0.30, 0.70, 0.55, 0.85], glassFrac: 0.12,
    relief: 0.3, parapetM: 0.8, corniceM: 0, sillM: 0, window: WindowStyle.Industrial, frameM: 0.05, mullions: 4,
    interior: Interior.Loft, roofs: [RoofCover.WhiteMembrane, RoofCover.BlackMembrane, RoofCover.Gravel, RoofCover.Tar],
    tank: 0, age: 0.55, shopfront: 0.06, group: 2, f0: COMMON.f0Punched, roughness: 0.85,
  },
  {
    id: "us-retail", name: "one- and two-storey commercial strip", region: Region.Generic, family: 2, era: [1920, 2010],
    districts: [0.4, 1.0, 0.5, 0.5], heightM: [3.5, 9.5], areaM2: [80, 4000], weight: 0.3,
    kinds: { 4: 6, 2: 2, 1: 0.15 },
    palette: [...SF_STUCCO.slice(0, 3), BUFF_BRICK[0], CHI_RED_BRICK[0], sw(Mat.Precast, 180, 174, 160)],
    trim: [lin(190, 184, 170)], frame: [ALUMINIUM, PAINT_BLACK], glass: CLEAR_GLASS,
    storeyM: 4.2, columnM: 3.5, win: [0.22, 0.78, 0.25, 0.80], glassFrac: 0.3,
    relief: 0.45, parapetM: 1.0, corniceM: 0.2, sillM: 0, window: WindowStyle.Casement, frameM: 0.06, mullions: 1,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.WhiteMembrane, RoofCover.BlackMembrane],
    tank: 0, age: 0.4, shopfront: 0.95, group: 2, f0: COMMON.f0Punched, roughness: 0.82,
  },
  {
    id: "us-civic", name: "stone civic building, school or church", region: Region.Generic, family: 4, era: [1880, 1960],
    districts: [0.6, 0.6, 0.6, 0.3], heightM: [7, 60], areaM2: [250, 20000], weight: 0.04,
    kinds: { 5: 12 },
    palette: [...LIMESTONE, ...GRANITE_BLOCK, CHI_RED_BRICK[0], CHI_RED_BRICK[2]], trim: LIMESTONE_TRIM, frame: [PAINT_BLACK, BRONZE, PAINT_WHITE],
    glass: CLEAR_GLASS,
    storeyM: 4.4, columnM: 3.2, win: [0.28, 0.72, 0.18, 0.86], glassFrac: 0.24,
    relief: 0.85, parapetM: 1.3, corniceM: 0.8, sillM: 0.15, window: WindowStyle.SashMuntin, frameM: 0.08, mullions: 3,
    interior: Interior.Office, roofs: [RoofCover.Tar, RoofCover.Gravel, RoofCover.BlackMembrane],
    tank: 0, age: 0.55, shopfront: 0.3, group: 2, f0: COMMON.f0Punched, roughness: 0.72,
  },
];

// --- the roof survey ---------------------------------------------------------------
//
// From altitude a city IS its roofs, so the cover of each type is surveyed as
// carefully as its wall. Read off aerial imagery of each district (the same
// Esri/USGS orthophoto tiles the terrain drape uses, at zoom 19):
//
//   * Pre-war walk-ups and apartment blocks in Manhattan and Brooklyn are
//     roughly a third silver aluminium coating, a third black tar or EPDM, and
//     a growing third white: NYC Local Law 21 (2011) made reflective coating
//     the default on any re-roof, and the NYC CoolRoofs programme has coated
//     well over ten million square feet since 2009.
//   * Offices are gravel ballast (1960-1990) or white TPO (since), with a few
//     sedum green roofs on newer and civic buildings.
//   * Row houses carry decks: pavers on pedestals over the membrane.
//   * Chicago's flats are black and silver; its Loop is gravel and white, and
//     the city required green or reflective roofs on new construction from 2001.
//   * San Francisco's flat roofs are tar and white, often with a deck; its
//     pitched houses are asphalt shingle and red clay tile (the Mediterranean
//     revival of the 1920s and 30s), and solar arrays have been common on
//     houses since the 2008 GoSolarSF incentive.
const T = RoofCover;
const P = PitchCover;
const ROOF_SURVEY: Record<string, Pick<Archetype, "roofs" | "pitched" | "solar">> = {
  "nyc-walkup": { roofs: [T.Silver, T.Silver, T.Tar, T.BlackMembrane, T.WhiteMembrane, T.WhiteMembrane, T.Pavers], solar: 0.04 },
  "nyc-brownstone": { roofs: [T.Tar, T.Silver, T.BlackMembrane, T.WhiteMembrane, T.Pavers, T.Pavers], pitched: [P.Slate, P.Asphalt], solar: 0.08 },
  "nyc-prewar-apt": { roofs: [T.Silver, T.Silver, T.Tar, T.BlackMembrane, T.WhiteMembrane, T.Pavers], solar: 0.02 },
  "nyc-loft": { roofs: [T.Tar, T.Silver, T.BlackMembrane, T.WhiteMembrane, T.Pavers, T.Green, T.Tar, T.Silver, T.BlackMembrane, T.WhiteMembrane, T.Pavers, T.Tar, T.Silver, T.BlackMembrane, T.WhiteMembrane, T.Pavers], solar: 0.04 },
  "nyc-deco-tower": { roofs: [T.Tar, T.Gravel, T.BlackMembrane], solar: 0 },
  "nyc-prewar-office": { roofs: [T.Tar, T.Gravel, T.Silver, T.WhiteMembrane, T.BlackMembrane], solar: 0 },
  "nyc-intl-slab": { roofs: [T.Gravel, T.Gravel, T.BlackMembrane, T.WhiteMembrane], solar: 0 },
  "nyc-white-brick": { roofs: [T.Tar, T.BlackMembrane, T.Silver, T.WhiteMembrane], solar: 0.02 },
  "nyc-projects": { roofs: [T.Tar, T.BlackMembrane, T.WhiteMembrane, T.Silver], solar: 0.03 },
  "nyc-house": { roofs: [T.Tar, T.BlackMembrane, T.Silver], pitched: [P.Asphalt, P.Asphalt, P.AsphaltBrown, P.Slate], solar: 0.06 },
  "sf-victorian": { roofs: [T.Tar, T.Tar, T.WhiteMembrane, T.Silver, T.Pavers], pitched: [P.Asphalt, P.AsphaltBrown, P.Slate, P.Shake], solar: 0.10 },
  "sf-edwardian": { roofs: [T.Tar, T.WhiteMembrane, T.Silver, T.Pavers, T.BlackMembrane], pitched: [P.Asphalt, P.AsphaltBrown], solar: 0.10 },
  "sf-stucco-apt": { roofs: [T.Tar, T.WhiteMembrane, T.WhiteMembrane, T.Gravel, T.Pavers], pitched: [P.ClayTile, P.Asphalt], solar: 0.06 },
  "sf-marina": { roofs: [T.Tar, T.WhiteMembrane, T.Pavers, T.BlackMembrane], pitched: [P.ClayTile, P.ClayTile, P.Asphalt], solar: 0.12 },
  "sf-postwar-apt": { roofs: [T.Tar, T.WhiteMembrane, T.Gravel, T.BlackMembrane], pitched: [P.Asphalt], solar: 0.06 },
  "sf-house": { roofs: [T.Tar, T.WhiteMembrane], pitched: [P.Asphalt, P.Asphalt, P.ClayTile, P.ClayTile, P.AsphaltBrown, P.Shake], solar: 0.18 },
  "sf-downtown-prewar": { roofs: [T.Tar, T.Gravel, T.WhiteMembrane, T.BlackMembrane], solar: 0.02 },
  "sf-soma-warehouse": { roofs: [T.Tar, T.Gravel, T.WhiteMembrane, T.WhiteMembrane, T.Green, T.Tar, T.Gravel, T.WhiteMembrane, T.WhiteMembrane, T.Tar, T.Gravel, T.WhiteMembrane, T.WhiteMembrane], solar: 0.12 },
  "chi-school": { roofs: [T.Tar, T.Gravel, T.WhiteMembrane, T.BlackMembrane], solar: 0 },
  "chi-mies": { roofs: [T.Gravel, T.BlackMembrane, T.WhiteMembrane], solar: 0 },
  "chi-deco": { roofs: [T.Tar, T.Gravel, T.Green, T.Tar, T.Gravel, T.Tar, T.Gravel], pitched: [P.Copper], solar: 0 },
  "chi-concrete": { roofs: [T.Gravel, T.BlackMembrane, T.WhiteMembrane], solar: 0.02 },
  "chi-courtyard": { roofs: [T.Tar, T.Silver, T.BlackMembrane, T.WhiteMembrane], solar: 0.03 },
  "chi-two-flat": { roofs: [T.Tar, T.Silver, T.BlackMembrane, T.WhiteMembrane], pitched: [P.Asphalt, P.Slate], solar: 0.04 },
  "chi-cottage": { roofs: [T.Tar, T.BlackMembrane], pitched: [P.Asphalt, P.Asphalt, P.AsphaltBrown, P.Slate], solar: 0.05 },
  "us-glass-tower": { roofs: [T.Gravel, T.WhiteMembrane, T.WhiteMembrane, T.Green, T.BlackMembrane, T.Gravel, T.WhiteMembrane, T.WhiteMembrane, T.BlackMembrane, T.Gravel, T.WhiteMembrane, T.WhiteMembrane, T.BlackMembrane], solar: 0.02 },
  "us-midrise-office": { roofs: [T.Gravel, T.WhiteMembrane, T.BlackMembrane, T.Green, T.Gravel, T.WhiteMembrane, T.BlackMembrane, T.Gravel, T.WhiteMembrane, T.BlackMembrane], solar: 0.06 },
  "us-residential-tower": { roofs: [T.WhiteMembrane, T.Gravel, T.Pavers, T.Green, T.WhiteMembrane, T.Gravel, T.Pavers, T.WhiteMembrane, T.Gravel, T.Pavers], solar: 0.03 },
  "us-warehouse": { roofs: [T.WhiteMembrane, T.WhiteMembrane, T.BlackMembrane, T.Gravel, T.Tar], solar: 0.14 },
  "us-retail": { roofs: [T.Tar, T.WhiteMembrane, T.WhiteMembrane, T.BlackMembrane, T.Gravel], solar: 0.08 },
  "us-civic": { roofs: [T.Tar, T.Gravel, T.BlackMembrane, T.Green, T.Tar, T.Gravel, T.BlackMembrane, T.Tar, T.Gravel, T.BlackMembrane], pitched: [P.Slate, P.Copper, P.Asphalt], solar: 0.04 },
};
for (const a of ARCHETYPES) {
  const r = ROOF_SURVEY[a.id];
  if (!r) throw new Error(`archetype ${a.id} has no roof survey`);
  Object.assign(a, r);
}

export const ARCHETYPE_COUNT = ARCHETYPES.length;

export function archetypeIndex(id: string): number {
  const i = ARCHETYPES.findIndex((a) => a.id === id);
  if (i < 0) throw new Error(`no archetype ${id}`);
  return i;
}

/** The archetypes a region draws from: its own survey plus the shared US set. */
export function archetypesFor(region: Region): number[] {
  if (region === Region.Generic) return [];
  const out: number[] = [];
  for (let i = 0; i < ARCHETYPES.length; i++) {
    const r = ARCHETYPES[i].region;
    if (r === region || r === Region.Generic) out.push(i);
  }
  return out;
}

// --- the weight of one archetype for one building ----------------------------

/** 1 inside [lo, hi], falling linearly to 0 at lo * a and hi * b. */
function trapezoid(v: number, lo: number, hi: number, a: number, b: number): number {
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return Math.max(0, (v - lo * a) / (lo - lo * a));
  return Math.max(0, (hi * b - v) / (hi * b - hi));
}

/** Great-circle-free distance in km from a pack-local point to a zone centre. */
function zoneKm(lat: number, lon: number, zLat: number, zLon: number): number {
  const dy = (lat - zLat) * 111.32;
  const dx = (lon - zLon) * 111.32 * Math.cos((zLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export interface WeightInput {
  kind: number;
  heightM: number;
  areaM2: number;
  district: District;
  lat: number;
  lon: number;
  tags?: BuildingTags;
}

/** Map OSM building:material onto the scans it can be. */
const MATERIAL_TAG: Record<string, Mat[]> = {
  brick: [Mat.RedBrick, Mat.OldBrick, Mat.BrownBrick, Mat.BuffBrick, Mat.PaintedBrick],
  stone: [Mat.Limestone, Mat.BlockStone],
  limestone: [Mat.Limestone],
  sandstone: [Mat.Limestone],
  granite: [Mat.BlockStone, Mat.Granite],
  concrete: [Mat.Precast, Mat.BoardConcrete],
  plaster: [Mat.Stucco],
  stucco: [Mat.Stucco],
  wood: [Mat.Siding],
  timber_framing: [Mat.Siding],
  glass: [Mat.MetalPanel],
  metal: [Mat.MetalPanel],
  steel: [Mat.MetalPanel],
  terracotta: [Mat.Terracotta],
};

export function archetypeWeight(a: Archetype, x: WeightInput): number {
  let w = a.weight * a.districts[x.district];
  if (w <= 0) return 0;
  // Height is sharp: a Victorian at 40 m or a curtain wall at 8 m are both
  // impossible, not unlikely. Area is softer, because a footprint in OSM is
  // often a whole block outline or half of a party-wall pair.
  // The shoulder above a TALL type is narrower: 30% past a 110 m pre-war
  // office is a 143 m tower, and with whole downtown blocks drawing on one
  // hash (clusters) a shift in cluster roots moved 10% of San Francisco's
  // core towers onto that shoulder when the building:part outlines went.
  w *= trapezoid(x.heightM, a.heightM[0], a.heightM[1], 0.75, a.heightM[1] >= 100 ? 1.12 : 1.3);
  if (w <= 0) return 0;
  w *= 0.12 + 0.88 * trapezoid(x.areaM2, a.areaM2[0], a.areaM2[1], 0.5, 2.0);
  w *= a.kinds?.[x.kind] ?? 1;
  if (a.zones) {
    let z = a.zoneElse ?? 1;
    for (const [lat, lon, r, m] of a.zones) {
      const d = zoneKm(x.lat, x.lon, lat, lon);
      if (d < r) z = Math.max(z, m * (1 - 0.5 * (d / r)));
    }
    w *= z;
  }
  const t = x.tags;
  if (t) {
    if (t.year !== undefined) {
      w *= t.year >= a.era[0] - 5 && t.year <= a.era[1] + 5 ? 2.5 : 0.08;
    }
    if (t.material) {
      const mats = MATERIAL_TAG[t.material];
      if (mats) w *= a.palette.some((s) => mats.includes(s.m)) ? 3 : 0.1;
    }
  }
  return w;
}

// --- the choice -------------------------------------------------------------------

/** What assignArchetypes decides for one building. */
export interface ArchetypeChoice {
  archetype: number;
  district: District;
  /** Cluster root index: the building whose seed drew the archetype. */
  cluster: number;
  tags?: BuildingTags;
}

const hashU = (a: number, b: number): number => {
  let h = (a | 0) * 0x27d4eb2d;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

export interface AssignOptions {
  /**
   * false draws per building instead of per cluster. The vacuity probe for the
   * coherence gate: it is the old behaviour, and the gate must fail on it.
   */
  coherence?: boolean;
}

export interface PackLike {
  lat0: number;
  lon0: number;
  buildings: readonly FootprintLike[];
}

/**
 * The archetype of every building in a pack, or null for a region with no
 * survey (the renderer then keeps the five-family path for it).
 */
export function assignArchetypes(pack: PackLike, opts: AssignOptions = {}): ArchetypeChoice[] | null {
  const region = regionAt(pack.lat0, pack.lon0);
  const pool = archetypesFor(region);
  if (!pool.length) return null;
  const bs = pack.buildings;
  const n = bs.length;
  const areas = new Float64Array(n);
  for (let i = 0; i < n; i++) areas[i] = footprintArea(bs[i].ring);
  const districts = classifyDistricts(bs, areas);
  const clusters = opts.coherence === false ? null : clusterNeighbours(bs);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((pack.lat0 * Math.PI) / 180);
  const out: ArchetypeChoice[] = new Array(n);
  const w = new Float64Array(pool.length);
  // A tower mapped as building:part volumes is ONE building: every part draws
  // with the whole tower's height, its biggest footprint and its tallest
  // record's seed, so the 20 m crown stage of a 443 m tower is not weighed as
  // a 20 m walk-up and the stack comes out in one stone.
  const groups = new Map<number, { lead: number; top: number; area: number }>();
  for (let i = 0; i < n; i++) {
    const id = bs[i].group;
    if (id === undefined) continue;
    const g = groups.get(id);
    if (!g) groups.set(id, { lead: i, top: bs[i].topM, area: areas[i] });
    else {
      if (bs[i].topM > g.top) { g.lead = i; g.top = bs[i].topM; }
      g.area = Math.max(g.area, areas[i]);
    }
  }
  for (let i = 0; i < n; i++) {
    const b = bs[i];
    const g = b.group !== undefined ? groups.get(b.group) : undefined;
    const lead = g ? bs[g.lead] : b;
    const x: WeightInput = {
      kind: lead.kind,
      heightM: g ? g.top : b.topM - b.baseM,
      areaM2: g ? g.area : areas[i],
      district: districts[g ? g.lead : i] as District,
      // ENU: x is east, z is SOUTH in this repo's frame (see geo.ts toWorld).
      lat: pack.lat0 - lead.cz / mPerDegLat,
      lon: pack.lon0 + lead.cx / mPerDegLon,
      tags: lead.tags ?? b.tags,
    };
    let total = 0;
    for (let k = 0; k < pool.length; k++) {
      w[k] = archetypeWeight(ARCHETYPES[pool[k]], x);
      total += w[k];
    }
    const root = clusters ? clusters[g ? g.lead : i] : g ? g.lead : i;
    let pick = pool[0];
    if (total > 0) {
      let r = hashU(root, 0xa2c4) * total;
      for (let k = 0; k < pool.length; k++) {
        r -= w[k];
        if (r <= 0) { pick = pool[k]; break; }
      }
    } else {
      // Nothing fits (a 600 m mast that survived the needle filter, a 2 m
      // kiosk): the nearest type by height, so it is at least the right scale.
      let best = Infinity;
      for (const k of pool) {
        const a = ARCHETYPES[k];
        const d = x.heightM < a.heightM[0] ? a.heightM[0] - x.heightM : Math.max(0, x.heightM - a.heightM[1]);
        if (d < best) { best = d; pick = k; }
      }
    }
    out[i] = { archetype: pick, district: districts[i] as District, cluster: root, tags: b.tags };
  }
  return out;
}

/**
 * Does this building get a wooden water tank on its roof?
 *
 * NYC building code required one on anything over six storeys that city water
 * pressure cannot reach, which is why there are about ten thousand of them and
 * why they sit on 6 to 20 storey pre-war buildings and almost never on a glass
 * tower (which pumps). 18 to 75 m is that storey range.
 */
export function wantsWaterTank(a: Archetype, heightM: number, seed: number): boolean {
  if (a.tank <= 0 || heightM < 18 || heightM > 75) return false;
  return hashU(seed, 0x7a4c) < a.tank;
}
