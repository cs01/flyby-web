// OpenStreetMap elements to building footprints with heights. The one copy.
//
// This is the half of tools/bake-city.ts that has nothing to do with Bun, the
// disk cache or the command line: parse a height out of free text, decide what
// kind of building it is, project a ring, wind it, quantise it. It used to live
// in tools/, which meant the browser could not reach it, which is why buildings
// only existed for the handful of cities somebody had baked a pack for.
//
// Both paths now come through here: the offline bake (which encodes the result
// to a .city file) and the runtime path (which hands the result straight to the
// renderer). That is the same discipline citypack.ts already applies to the
// FORMAT, applied to the CONVERSION, and it is what makes "a live city and a
// baked city are the same city" checkable rather than hopeful.
//
// PURE: no fetch, no cache, no DOM, no Bun.

import { Origin } from "../geo";
import {
  BuildingKind, MATERIAL_CODES, ROOF_MATERIAL_CODES, RoofShape, isNeedle, quantiseColour, quantiseLevels,
  quantiseRoofHeight, type BuildingTags, type PackedBuilding,
} from "./citypack";
import { bboxFilter, Skips, type OsmBbox, type OsmElement, type OsmPt } from "./osm";

// --- tunables ---------------------------------------------------------------

/** Metres per vertex-offset unit. Must match VERT_SCALE in citypack.ts. */
export const QUANT = 0.25;
/** |offset| units; 8000 m. Past this the record cannot be written. */
export const I16_LIMIT = 32000;
export const MIN_AREA_M2 = 12;
export const MIN_TOP_M = 2;
export const MAX_TOP_M = 900;
export const LEVEL_HEIGHT_M = 3.2;

// --- length parsing ---------------------------------------------------------

const FEET_INCH = /^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*(\d+(?:\.\d+)?)\s*(?:"|''|in|inch(?:es)?)?$/;
const VALUE_UNIT = /^(-?\d+(?:[.,]\d+)?)\s*([a-z'"]*)$/;

/**
 * OSM height values are free text. A bare number is metres by convention, but
 * US mappers write feet in three different spellings and the `12'6"` form
 * shows up on low-rise housing. Anything else is dropped rather than guessed:
 * a wrong unit here is a 3x error in the skyline.
 */
export function parseLength(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (s === "") return null;

  const fi = FEET_INCH.exec(s);
  if (fi) {
    const ft = Number(fi[1]);
    const inch = Number(fi[2]);
    if (!Number.isFinite(ft) || !Number.isFinite(inch)) return null;
    return (ft * 12 + inch) * 0.0254;
  }

  const vu = VALUE_UNIT.exec(s);
  if (!vu) return null;
  const v = Number(vu[1].replace(",", "."));
  if (!Number.isFinite(v)) return null;
  switch (vu[2]) {
    case "":
    case "m":
    case "metre":
    case "metres":
    case "meter":
    case "meters":
      return v;
    case "'":
    case "ft":
    case "feet":
    case "foot":
      return v * 0.3048;
    default:
      return null;
  }
}

/** `building:levels` is often `4`, sometimes `4.5`, sometimes `3;4`. */
export function parseLevels(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^-?\d+(?:[.,]\d+)?/.exec(raw.trim());
  if (!m) return null;
  const v = Number(m[0].replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// --- tag interpretation -----------------------------------------------------

export const FALLBACK_HEIGHT: Record<string, number> = {
  house: 6,
  detached: 6,
  bungalow: 6,
  semidetached_house: 6,
  terrace: 6,
  apartments: 15,
  residential: 10,
  dormitory: 10,
  hotel: 15,
  commercial: 14,
  office: 14,
  retail: 8,
  supermarket: 8,
  kiosk: 8,
  industrial: 10,
  warehouse: 10,
  manufacture: 10,
  church: 20,
  cathedral: 20,
  chapel: 20,
  mosque: 20,
  temple: 20,
  synagogue: 20,
  school: 12,
  university: 12,
  college: 12,
  hospital: 12,
  civic: 12,
  public: 12,
  government: 12,
  garage: 3,
  garages: 3,
  shed: 3,
  hut: 3,
  carport: 3,
  roof: 3,
};

/** The height a building with no height and no levels gets. */
export const DEFAULT_HEIGHT_M = 9;

const KIND_BY_BUILDING: Record<string, BuildingKind> = {
  house: BuildingKind.Residential,
  detached: BuildingKind.Residential,
  bungalow: BuildingKind.Residential,
  semidetached_house: BuildingKind.Residential,
  terrace: BuildingKind.Residential,
  apartments: BuildingKind.Residential,
  residential: BuildingKind.Residential,
  dormitory: BuildingKind.Residential,
  house_boat: BuildingKind.Residential,
  commercial: BuildingKind.Commercial,
  office: BuildingKind.Commercial,
  hotel: BuildingKind.Commercial,
  industrial: BuildingKind.Industrial,
  warehouse: BuildingKind.Industrial,
  manufacture: BuildingKind.Industrial,
  hangar: BuildingKind.Industrial,
  retail: BuildingKind.Retail,
  supermarket: BuildingKind.Retail,
  kiosk: BuildingKind.Retail,
  church: BuildingKind.Civic,
  cathedral: BuildingKind.Civic,
  chapel: BuildingKind.Civic,
  mosque: BuildingKind.Civic,
  temple: BuildingKind.Civic,
  synagogue: BuildingKind.Civic,
  shrine: BuildingKind.Civic,
  monastery: BuildingKind.Civic,
  school: BuildingKind.Civic,
  university: BuildingKind.Civic,
  college: BuildingKind.Civic,
  kindergarten: BuildingKind.Civic,
  hospital: BuildingKind.Civic,
  civic: BuildingKind.Civic,
  public: BuildingKind.Civic,
  government: BuildingKind.Civic,
  museum: BuildingKind.Civic,
  train_station: BuildingKind.Civic,
  transportation: BuildingKind.Civic,
  stadium: BuildingKind.Civic,
  tower: BuildingKind.Tower,
  skyscraper: BuildingKind.Tower,
};

// --- what it is made of ------------------------------------------------------

/** The CSS colour names OSM mappers actually use on buildings, as sRGB. */
const NAMED_COLOUR: Record<string, [number, number, number]> = {
  white: [240, 240, 236], black: [30, 30, 30], grey: [128, 128, 128], gray: [128, 128, 128],
  silver: [192, 192, 192], red: [160, 60, 50], maroon: [110, 40, 36], brown: [120, 80, 56],
  tan: [210, 180, 140], beige: [222, 210, 180], yellow: [230, 200, 90], orange: [210, 120, 60],
  pink: [230, 180, 180], green: [90, 130, 90], olive: [128, 128, 64], blue: [90, 120, 170],
  navy: [40, 50, 90], cream: [240, 230, 200], ivory: [240, 236, 220], lightgrey: [200, 200, 200],
  lightgray: [200, 200, 200], darkgrey: [80, 80, 80], darkgray: [80, 80, 80], sandybrown: [220, 160, 100],
};

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/**
 * An OSM colour value (#rgb, #rrggbb or a CSS name) to linear rgb, or null.
 *
 * Mappers write the colour of the paint, which is a reflectance seen in
 * daylight, so it is treated as an sRGB albedo. Clamped to 0.03..0.75 linear: a
 * "white" building is not a 0.87 albedo surface after a city winter, and a
 * "black" one is still lit by the sky.
 */
export function parseOsmColour(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/[\s_]/g, "");
  let rgb: [number, number, number] | null = NAMED_COLOUR[v] ?? null;
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (!rgb && hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (!rgb) return null;
  return rgb.map((c) => Math.min(0.75, Math.max(0.03, srgbToLinear(c)))) as [number, number, number];
}

/**
 * The material evidence on one element, or null when it has none.
 *
 * Every value is snapped to what a .city pack can hold (a material in the code
 * table, a colour on the sRGB byte grid, half-storey levels), on the live path
 * too, so a live city and a baked one carry exactly the same evidence.
 */
export function materialTags(tags: Record<string, string>): BuildingTags | null {
  const out: BuildingTags = {};
  const material = (tags["building:material"] ?? tags["building:facade:material"] ?? "").trim().toLowerCase();
  if ((MATERIAL_CODES as readonly string[]).includes(material)) out.material = material;
  const colour = parseOsmColour(tags["building:colour"] ?? tags["building:facade:colour"]);
  if (colour) out.colour = quantiseColour(colour);
  const roofColour = parseOsmColour(tags["roof:colour"]);
  if (roofColour) out.roofColour = quantiseColour(roofColour);
  const roofMaterial = (tags["roof:material"] ?? "").trim().toLowerCase();
  if ((ROOF_MATERIAL_CODES as readonly string[]).includes(roofMaterial)) out.roofMaterial = roofMaterial;
  const year = /(\d{4})/.exec(tags["start_date"] ?? tags["construction_date"] ?? "");
  if (year) {
    const y = Number(year[1]);
    if (y >= 1600 && y <= 2100) out.year = y;
  }
  const levels = parseLevels(tags["building:levels"]);
  if (levels !== null && levels >= 1) out.levels = quantiseLevels(levels);
  return Object.keys(out).length ? out : null;
}

export function classifyKind(tags: Record<string, string>, topM: number): BuildingKind {
  const b = (tags["building"] ?? tags["building:part"] ?? "").toLowerCase();
  const direct = KIND_BY_BUILDING[b];
  if (direct !== undefined) {
    // A 300 m "commercial" is a skyscraper to the renderer regardless of its tag.
    if (topM >= 100 && direct !== BuildingKind.Civic) return BuildingKind.Tower;
    return direct;
  }
  if (topM >= 100) return BuildingKind.Tower;
  if (tags["man_made"] === "tower" || tags["man_made"] === "communications_tower") {
    return BuildingKind.Tower;
  }
  if (tags["office"] !== undefined) return BuildingKind.Commercial;
  if (tags["shop"] !== undefined) return BuildingKind.Retail;
  if (tags["amenity"] === "place_of_worship") return BuildingKind.Civic;
  if (tags["amenity"] !== undefined || tags["tourism"] !== undefined) return BuildingKind.Civic;
  if (tags["industrial"] !== undefined) return BuildingKind.Industrial;
  return BuildingKind.Generic;
}

const ROOF_BY_SHAPE: Record<string, RoofShape> = {
  flat: RoofShape.Flat,
  gabled: RoofShape.Pitched,
  "half-hipped": RoofShape.Pitched,
  hipped: RoofShape.Pitched,
  "gabled-hipped": RoofShape.Pitched,
  gambrel: RoofShape.Pitched,
  mansard: RoofShape.Pitched,
  skillion: RoofShape.Pitched,
  "double_saltbox": RoofShape.Pitched,
  saltbox: RoofShape.Pitched,
  round: RoofShape.Pitched,
  "side_half_hipped": RoofShape.Pitched,
  dome: RoofShape.Dome,
  onion: RoofShape.Dome,
  cupola: RoofShape.Dome,
  pyramidal: RoofShape.Pyramid,
  "half-pyramidal": RoofShape.Pyramid,
  quadruple_saltbox: RoofShape.Pyramid,
  spherical: RoofShape.Dome,
  cone: RoofShape.Tapered,
  conical: RoofShape.Tapered,
  spire: RoofShape.Tapered,
  pyramidal_spire: RoofShape.Tapered,
  tented: RoofShape.Tapered,
};

/** Above this, an untagged residential building is flat. See below. */
export const PITCHED_MAX_M = 15;

export function classifyRoof(
  tags: Record<string, string>,
  kind: BuildingKind,
  topM: number,
): RoofShape {
  const shape = (tags["roof:shape"] ?? tags["building:roof:shape"] ?? "").toLowerCase();
  const mapped = ROOF_BY_SHAPE[shape];
  if (mapped !== undefined) return mapped;
  // Untagged: a church/spire silhouette is the one that reads wrong as a box.
  const b = (tags["building"] ?? "").toLowerCase();
  if (b === "church" || b === "cathedral" || b === "chapel") return RoofShape.Tapered;
  if (b === "mosque" || b === "temple" || b === "synagogue") return RoofShape.Dome;
  // Height gates the guess, and it has to: `building=residential` is tagged on
  // 200 m towers as readily as on bungalows, and without this a Hong Kong
  // block came out with a 4.5 m tent on top of it. A pitched roof spans the
  // building, so it survives to about four storeys and then stops; anything
  // taller has a flat deck with the plant on it. A roof:shape that somebody
  // actually mapped is still believed at any height, because it is evidence
  // rather than a guess.
  if (kind === BuildingKind.Residential && b !== "apartments" && topM <= PITCHED_MAX_M) {
    return RoofShape.Pitched;
  }
  return RoofShape.Flat;
}

export interface Heights {
  baseM: number;
  topM: number;
}

/** Priority: explicit height, then levels x storey height, then a tag guess. */
export function resolveHeights(tags: Record<string, string>): Heights | null {
  let top: number | null = parseLength(tags["height"] ?? tags["building:height"]);

  if (top === null) {
    const levels = parseLevels(tags["building:levels"] ?? tags["levels"]);
    if (levels !== null) {
      top = levels * LEVEL_HEIGHT_M;
      const roofH = parseLength(tags["roof:height"]);
      if (roofH !== null) top += roofH;
    }
  }

  if (top === null) {
    const b = (tags["building"] ?? tags["building:part"] ?? "").toLowerCase();
    top = FALLBACK_HEIGHT[b] ?? DEFAULT_HEIGHT_M;
  }

  let base = parseLength(tags["min_height"] ?? tags["building:min_height"]);
  if (base === null) {
    const minLevel = parseLevels(tags["building:min_level"] ?? tags["min_level"]);
    base = minLevel !== null ? minLevel * LEVEL_HEIGHT_M : 0;
  }
  if (!Number.isFinite(base) || base < 0) base = 0;

  const topM = Math.min(MAX_TOP_M, Math.max(MIN_TOP_M, top));
  if (topM <= base) return null;
  return { baseM: base, topM };
}

// --- geometry ---------------------------------------------------------------

export interface Ring {
  x: number[];
  z: number[];
}

/** Drop the OSM closing duplicate and any consecutive repeats. */
export function toRing(origin: Origin, pts: OsmPt[]): Ring | null {
  const x: number[] = [];
  const z: number[] = [];
  for (const p of pts) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const w = origin.toWorld(p.lat, p.lon);
    const n = x.length;
    if (n > 0 && Math.abs(w.x - x[n - 1]) < 1e-6 && Math.abs(w.z - z[n - 1]) < 1e-6) continue;
    x.push(w.x);
    z.push(w.z);
  }
  while (
    x.length > 1 &&
    Math.abs(x[0] - x[x.length - 1]) < 1e-6 &&
    Math.abs(z[0] - z[z.length - 1]) < 1e-6
  ) {
    x.pop();
    z.pop();
  }
  if (x.length < 3) return null;
  return { x, z };
}

/** Shoelace with y := z, so positive means counter-clockwise in (x, z). */
export function signedArea(r: Ring): number {
  let a = 0;
  const n = r.x.length;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += r.x[i] * r.z[j] - r.x[j] * r.z[i];
  }
  return a / 2;
}

function reverse(r: Ring): void {
  r.x.reverse();
  r.z.reverse();
}

// --- the query --------------------------------------------------------------

/**
 * Every building in a box.
 *
 * `out geom` and not `out tags geom`: the `tags` verbosity drops a relation's
 * member list entirely, so `geom` has nothing to hang geometry off and every
 * multipolygon building comes back as bare tags + a bounding box. Measured on
 * SF that silently discarded 645 relations. `geom` implies body verbosity,
 * which carries tags anyway, so nothing is lost.
 */
export function buildingsStatements(b: OsmBbox): string {
  const box = bboxFilter(b);
  return `way["building"](${box});
 way["building:part"](${box});
 relation["building"](${box});`;
}

export function buildingsQuery(b: OsmBbox, timeoutS = 120): string {
  return `[out:json][timeout:${timeoutS}];
(${buildingsStatements(b)});
out geom;`;
}

/**
 * True for the elements buildingsQuery asks for, and only those.
 *
 * The converter below trusts its input: it turns every way it is handed into a
 * footprint, because in a bake the query has already guaranteed that is what
 * they are. The runtime path asks for buildings, roads and vegetation in ONE
 * request (three would be three times the load on a volunteer server), so it
 * has to do that filtering itself, and this is the predicate that says what the
 * baker's query would have returned. Mirrors it exactly, relation clause and
 * all: a relation carrying only `building:part` is not in the bake and must not
 * appear live either.
 */
export function isBuildingElement(el: OsmElement): boolean {
  const t = el.tags ?? {};
  if (el.type === "way") return t["building"] !== undefined || t["building:part"] !== undefined;
  if (el.type === "relation") return t["building"] !== undefined;
  return false;
}

// --- the conversion ---------------------------------------------------------

export interface BuildingConversion {
  buildings: PackedBuilding[];
  skips: Skips;
  parts: PartStats;
}

// --- building:part massing ------------------------------------------------------
//
// OSM's Simple 3D Buildings scheme maps a setback tower twice: an OUTLINE
// (`building=*`) carrying the whole footprint at the full height, and inside it
// the `building:part` volumes, each with its own min_height, height and roof.
// The parts were always in the query and always in the packs; what made every
// tower a box is that the outline was extruded too, at 443 m over the whole
// Empire State footprint, and every setback stood inside it unseen.
//
// The scheme says a renderer that draws parts should not draw the outline. Real
// data needs a softer rule, because the parts are often incomplete: the Empire
// State's parts start at 16 m, so the podium below them exists only as the
// outline. So the outline is DROPPED where its ground-standing parts cover it,
// and otherwise CLIPPED to the lowest part base above it, which leaves exactly
// the podium the parts stand on.

/** Ground cover by base-level parts above which the outline is dropped. */
export const PART_COVER_DROP = 0.8;
/** A part standing within this of the ground counts as ground cover, metres. */
export const PART_GROUND_M = 1.0;

export interface PartStats {
  /** Outlines replaced outright by their parts. */
  dropped: number;
  /** Outlines cut down to the podium under their parts. */
  clipped: number;
  /** Parts that found the outline they belong to. */
  grouped: number;
}

/** Point in a quantised ring (offsets from cx, cz in QUANT units). */
function insidePacked(b: PackedBuilding, x: number, z: number): boolean {
  const n = b.dx.length;
  const px = (x - b.cx) / QUANT, pz = (z - b.cz) / QUANT;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = b.dx[i], zi = b.dz[i], xj = b.dx[j], zj = b.dz[j];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function packedArea(b: PackedBuilding): number {
  let a2 = 0;
  const n = b.dx.length;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a2 += b.dx[i] * b.dz[j] - b.dx[j] * b.dz[i];
  }
  return Math.abs(a2 / 2) * QUANT * QUANT;
}

function packedBox(b: PackedBuilding): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < b.dx.length; i++) {
    x0 = Math.min(x0, b.dx[i]); x1 = Math.max(x1, b.dx[i]);
    z0 = Math.min(z0, b.dz[i]); z1 = Math.max(z1, b.dz[i]);
  }
  return [b.cx + x0 * QUANT, b.cx + x1 * QUANT, b.cz + z0 * QUANT, b.cz + z1 * QUANT];
}

/**
 * Resolve outlines against their parts. Returns the kept records (in order)
 * and the flags that ride alongside them.
 *
 * @param isPart per record, true when it came from a `building:part` element.
 */
export function resolveParts(
  buildings: PackedBuilding[],
  isPart: readonly boolean[],
  roofTagged: readonly boolean[],
): { buildings: PackedBuilding[]; roofTagged: boolean[]; stats: PartStats } {
  const stats: PartStats = { dropped: 0, clipped: 0, grouped: 0 };
  const CELL = 50;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < buildings.length; i++) {
    if (!isPart[i]) continue;
    const k = `${Math.floor(buildings[i].cx / CELL)},${Math.floor(buildings[i].cz / CELL)}`;
    const l = cells.get(k);
    if (l) l.push(i); else cells.set(k, [i]);
  }
  if (cells.size === 0) return { buildings, roofTagged: [...roofTagged], stats };

  // Smallest outline first, so a part inside a building inside a campus
  // outline belongs to the building.
  const outlines: { i: number; area: number }[] = [];
  for (let i = 0; i < buildings.length; i++) if (!isPart[i]) outlines.push({ i, area: packedArea(buildings[i]) });
  outlines.sort((a, b) => a.area - b.area);

  const owner = new Int32Array(buildings.length).fill(-1);
  const drop = new Uint8Array(buildings.length);
  for (const { i, area } of outlines) {
    const o = buildings[i];
    const [x0, x1, z0, z1] = packedBox(o);
    const mine: number[] = [];
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
      for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
        for (const j of cells.get(`${gx},${gz}`) ?? []) {
          if (owner[j] >= 0) continue;
          const p = buildings[j];
          if (p.cx < x0 || p.cx > x1 || p.cz < z0 || p.cz > z1) continue;
          if (!insidePacked(o, p.cx, p.cz)) continue;
          // A "part" bigger than the outline is a neighbour's, not this one's.
          if (packedArea(p) > area * 1.1) continue;
          mine.push(j);
        }
      }
    }
    if (!mine.length) continue;
    for (const j of mine) owner[j] = i;
    stats.grouped += mine.length;

    // How much of the footprint the ground-standing parts cover, on a 12 x 12
    // grid of samples inside it.
    let inside = 0, covered = 0;
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        const x = x0 + ((a + 0.5) / 12) * (x1 - x0);
        const z = z0 + ((b + 0.5) / 12) * (z1 - z0);
        if (!insidePacked(o, x, z)) continue;
        inside++;
        for (const j of mine) {
          const p = buildings[j];
          if (p.baseM - o.baseM <= PART_GROUND_M && insidePacked(p, x, z)) { covered++; break; }
        }
      }
    }
    const group = i;
    for (const j of mine) buildings[j].group = group;
    if (inside > 0 && covered / inside >= PART_COVER_DROP) {
      drop[i] = 1;
      stats.dropped++;
      continue;
    }
    let lowest = Infinity;
    for (const j of mine) {
      const b = buildings[j].baseM;
      if (b - o.baseM > PART_GROUND_M && b < lowest) lowest = b;
    }
    o.group = group;
    if (Number.isFinite(lowest) && lowest < o.topM) {
      // The podium. At least a storey, or what is left is a sliver of roof.
      o.topM = Math.max(o.baseM + 3, lowest);
      o.roof = RoofShape.Flat;
      delete o.roofM;
      stats.clipped++;
    }
  }

  const kept: PackedBuilding[] = [];
  const keptRoof: boolean[] = [];
  for (let i = 0; i < buildings.length; i++) {
    if (drop[i]) continue;
    kept.push(buildings[i]);
    keptRoof.push(roofTagged[i]);
  }
  return { buildings: kept, roofTagged: keptRoof, stats };
}

// --- zoning inference -------------------------------------------------------
//
// 86-90% of every pack is `building=yes` and lands in BuildingKind.Generic
// (85.7% chicago, 85.7% emeraldhills, 87.0% manhattan, 89.9% sf, measured over
// the shipped packs). A suburb is almost entirely that, so a street of houses
// renders as a row of flat commercial slabs: no pitched roof, parapets and
// chillers on top of every bungalow. The tags cannot be fixed from here, but
// the SHAPE of a subdivision can be read off the footprints, which is what the
// pass below does.

/** Two storeys and a roof. Anything taller is not a detached house. */
export const HOUSE_MAX_TOP_M = 9.0;
/**
 * A detached single-family house is 90-350 m^2. The slop takes in small
 * terraces and generous lots; under the floor is a shed, over the ceiling is a
 * pad. Measured on the packs' tagged buildings, dropping the floor to 35 m^2
 * or lifting the ceiling to 550 m^2 buys about a point of recall each and
 * costs about a point of false positives each, so neither pays for itself.
 */
export const HOUSE_MIN_AREA_M2 = 45;
export const HOUSE_MAX_AREA_M2 = 400;
/**
 * A house wall is 10-18 m, a house with an attached double garage reaches the
 * low 20s, and a warehouse elevation is 40 m+. This is the single cleanest
 * separator between the two ends: on the packs' tagged buildings the recall
 * this rule can possibly reach, before the density test takes any of it back,
 * is 0.64 at an 18 m cap, 0.80 at 22 m and 0.87 at 25 m, against a
 * false-positive ceiling of 0.078 / 0.119 / 0.145. 22 m leaves nothing for the
 * density term to spend (it would have to run at N=2 to clear a 0.75 recall
 * target, which is not a density test at all), so the cap is 25.
 */
export const HOUSE_MAX_EDGE_M = 25;
/**
 * The neighbour test, which is what actually carries the decision.
 *
 * A subdivision is a run of near-identical small footprints at regular
 * spacing. A lone small footprint next to nothing else small is a kiosk, a
 * substation or a pump house. Density is the signal that separates those two,
 * and it is the signal a road-class test (unavailable here: roads are a
 * separate pack, and this module has no access to one) would only have been
 * standing in for.
 *
 * Tuned against the packs' own labels, swept over 35-45 m^2 floors, 400-550
 * m^2 ceilings, 22-28 m edges, 60-80 m radii and N of 4-10. The frontier is
 * flat in the radius (60, 70 and 80 m reach the same recall for the same false
 * positives, at a different N), so the count is the real knob and 70 m is
 * kept. N=6 lands at recall 0.799 for a 0.066 false-positive rate; N=4 would
 * be 0.829 for 0.083 and N=10 would be 0.715 for 0.044.
 */
export const NEIGHBOUR_RADIUS_M = 70;
export const MIN_NEIGHBOURS = 6;

/** Footprint area and longest edge, in metres, from the quantised offsets. */
function houseMetrics(b: PackedBuilding): { area: number; longestEdge: number } {
  const n = b.dx.length;
  let a2 = 0;
  let longest = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a2 += b.dx[i] * b.dz[j] - b.dx[j] * b.dz[i];
    const ex = (b.dx[j] - b.dx[i]) * QUANT;
    const ez = (b.dz[j] - b.dz[i]) * QUANT;
    const e = Math.hypot(ex, ez);
    if (e > longest) longest = e;
  }
  return { area: Math.abs(a2 / 2) * QUANT * QUANT, longestEdge: longest };
}

/**
 * Promote untagged footprints that are geometrically houses. Mutates in place.
 *
 * Runs as a second pass because the decision needs neighbour context that does
 * not exist until every footprint has been placed.
 *
 * A promoted building takes a pitched roof only where the mapper said nothing
 * about the roof. `roofTagged[i]` is true when element i carried an explicit
 * `roof:shape`, and somebody who wrote `roof:shape=flat` on their house is
 * evidence: classifyRoof already believes them, and so does this.
 *
 * @returns how many buildings were promoted.
 */
export function inferResidential(
  buildings: PackedBuilding[],
  roofTagged: readonly boolean[],
): number {
  const candidates: number[] = [];
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b.kind !== BuildingKind.Generic) continue;
    if (b.topM > HOUSE_MAX_TOP_M) continue;
    const { area, longestEdge } = houseMetrics(b);
    if (area < HOUSE_MIN_AREA_M2 || area > HOUSE_MAX_AREA_M2) continue;
    if (longestEdge > HOUSE_MAX_EDGE_M) continue;
    candidates.push(i);
  }

  // Bucketed at exactly the search radius so the 3x3 neighbourhood of a cell
  // contains every point within it: 180k buildings is far too many for the
  // O(n^2) version of this loop.
  const cells = new Map<string, number[]>();
  const cellOf = (b: PackedBuilding): string =>
    `${Math.floor(b.cx / NEIGHBOUR_RADIUS_M)},${Math.floor(b.cz / NEIGHBOUR_RADIUS_M)}`;
  for (const i of candidates) {
    const key = cellOf(buildings[i]);
    const list = cells.get(key);
    if (list === undefined) cells.set(key, [i]);
    else list.push(i);
  }

  const r2 = NEIGHBOUR_RADIUS_M * NEIGHBOUR_RADIUS_M;
  let promoted = 0;
  for (const i of candidates) {
    const b = buildings[i];
    const gx = Math.floor(b.cx / NEIGHBOUR_RADIUS_M);
    const gz = Math.floor(b.cz / NEIGHBOUR_RADIUS_M);
    let near = 0;
    for (let ox = -1; ox <= 1 && near < MIN_NEIGHBOURS; ox++) {
      for (let oz = -1; oz <= 1 && near < MIN_NEIGHBOURS; oz++) {
        const list = cells.get(`${gx + ox},${gz + oz}`);
        if (list === undefined) continue;
        for (const j of list) {
          if (j === i) continue;
          const dx = buildings[j].cx - b.cx;
          const dz = buildings[j].cz - b.cz;
          if (dx * dx + dz * dz <= r2 && ++near >= MIN_NEIGHBOURS) break;
        }
      }
    }
    if (near < MIN_NEIGHBOURS) continue;
    b.kind = BuildingKind.Residential;
    if (!roofTagged[i]) b.roof = RoofShape.Pitched;
    promoted++;
  }
  return promoted;
}

/**
 * OSM elements to packed buildings, in the order the elements arrive.
 *
 * @param origin the scene's tangent plane. Not derived here: a second origin
 *   computed elsewhere drifts by metres and puts the buildings beside the
 *   terrain rather than on it.
 * @param radiusM centroids beyond this from the origin are dropped.
 */
export function buildingsFromOsm(
  elements: readonly OsmElement[],
  origin: Origin,
  radiusM: number,
): BuildingConversion {
  const skips = new Skips();
  const buildings: PackedBuilding[] = [];
  // One flag per PUSHED building, not per element: a relation contributes an
  // outer ring per member, and an array built per element would slip out of
  // alignment the first time one did.
  const roofTagged: boolean[] = [];
  const isPart: boolean[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (tags["building"] === "no" || tags["building:part"] === "no") {
      skips.add("tagged building=no");
      continue;
    }

    const rings: Ring[] = [];
    if (el.type === "way") {
      if (!el.geometry || el.geometry.length === 0) {
        skips.add("way with no geometry");
        continue;
      }
      const r = toRing(origin, el.geometry);
      if (r === null) {
        skips.add("ring under 3 distinct vertices");
        continue;
      }
      rings.push(r);
    } else if (el.type === "relation") {
      let sawOuter = false;
      for (const m of el.members ?? []) {
        if (m.role !== "outer" || !m.geometry || m.geometry.length === 0) continue;
        sawOuter = true;
        const r = toRing(origin, m.geometry);
        if (r === null) {
          skips.add("ring under 3 distinct vertices");
          continue;
        }
        rings.push(r);
      }
      if (!sawOuter) {
        skips.add("relation with no outer geometry");
        continue;
      }
      if (rings.length === 0) continue;
    } else {
      skips.add(`unhandled element type ${el.type}`);
      continue;
    }

    const heights = resolveHeights(tags);
    if (heights === null) {
      skips.add("top height not above base");
      continue;
    }
    const kind = classifyKind(tags, heights.topM);
    const roof = classifyRoof(tags, kind, heights.topM);
    const taggedRoof =
      ROOF_BY_SHAPE[(tags["roof:shape"] ?? tags["building:roof:shape"] ?? "").toLowerCase()] !==
      undefined;

    for (const ring of rings) {
      const area = signedArea(ring);
      if (Math.abs(area) < MIN_AREA_M2) {
        skips.add("footprint under 12 m^2");
        continue;
      }
      // Uniform winding: the renderer's triangulation and face winding assume it.
      if (area < 0) reverse(ring);

      const n = ring.x.length;
      let sx = 0;
      let sz = 0;
      for (let i = 0; i < n; i++) {
        sx += ring.x[i];
        sz += ring.z[i];
      }
      const cx = sx / n;
      const cz = sz / n;

      if (Math.hypot(cx, cz) > radiusM) {
        skips.add("centroid outside radius");
        continue;
      }
      if (n > 65535) {
        skips.add("ring over 65535 vertices");
        continue;
      }

      // Masts, spires and antennae, which OSM tags as buildings and which
      // extrude into black needles. The predicate lives in the pack module so
      // the bake, the loader and the verifier cannot disagree about what one is.
      let minRX = Infinity, maxRX = -Infinity, minRZ = Infinity, maxRZ = -Infinity;
      for (let i = 0; i < n; i++) {
        if (ring.x[i] < minRX) minRX = ring.x[i];
        if (ring.x[i] > maxRX) maxRX = ring.x[i];
        if (ring.z[i] < minRZ) minRZ = ring.z[i];
        if (ring.z[i] > maxRZ) maxRZ = ring.z[i];
      }
      if (isNeedle(heights.topM - heights.baseM, Math.min(maxRX - minRX, maxRZ - minRZ))) {
        skips.add("mast-shaped: tall on a footprint too small to stand on");
        continue;
      }

      const dx = new Int16Array(n);
      const dz = new Int16Array(n);
      let overflow = false;
      for (let i = 0; i < n; i++) {
        const qx = Math.round((ring.x[i] - cx) / QUANT);
        const qz = Math.round((ring.z[i] - cz) / QUANT);
        if (Math.abs(qx) > I16_LIMIT || Math.abs(qz) > I16_LIMIT) {
          overflow = true;
          break;
        }
        dx[i] = qx;
        dz[i] = qz;
      }
      if (overflow) {
        // A footprint over 8 km across is a broken multipolygon, not a building.
        skips.add("vertex offset overflows i16 (bad relation)");
        continue;
      }

      const evidence = materialTags(tags);
      // roof:height only means something on a shaped roof: it is how much of
      // the record is spire, dome or pyramid rather than wall.
      const roofH = roof !== RoofShape.Flat ? parseLength(tags["roof:height"]) : null;
      const roofM = roofH !== null && roofH > 0 && roofH < heights.topM - heights.baseM
        ? quantiseRoofHeight(roofH) : undefined;
      buildings.push({
        cx, cz, baseM: heights.baseM, topM: heights.topM, kind, roof, dx, dz,
        ...(evidence ? { tags: evidence } : {}),
        ...(roofM !== undefined ? { roofM } : {}),
      });
      roofTagged.push(taggedRoof);
      // An element tagged both ways is drawn as a part: it is a volume, and
      // treating it as an outline could drop it in favour of itself.
      isPart.push(tags["building:part"] !== undefined);
    }
  }

  const resolved = resolveParts(buildings, isPart, roofTagged);
  if (resolved.stats.dropped) skips.add("outline replaced by its building:part massing", resolved.stats.dropped);
  inferResidential(resolved.buildings, resolved.roofTagged);

  return { buildings: resolved.buildings, skips, parts: resolved.stats };
}
