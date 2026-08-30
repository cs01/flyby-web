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
import { BuildingKind, RoofShape, isNeedle, type PackedBuilding } from "./citypack";
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

export function classifyRoof(tags: Record<string, string>, kind: BuildingKind): RoofShape {
  const shape = (tags["roof:shape"] ?? tags["building:roof:shape"] ?? "").toLowerCase();
  const mapped = ROOF_BY_SHAPE[shape];
  if (mapped !== undefined) return mapped;
  // Untagged: a church/spire silhouette is the one that reads wrong as a box.
  const b = (tags["building"] ?? "").toLowerCase();
  if (b === "church" || b === "cathedral" || b === "chapel") return RoofShape.Tapered;
  if (b === "mosque" || b === "temple" || b === "synagogue") return RoofShape.Dome;
  if (kind === BuildingKind.Residential && b !== "apartments") return RoofShape.Pitched;
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
    const roof = classifyRoof(tags, kind);

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

      buildings.push({ cx, cz, baseM: heights.baseM, topM: heights.topM, kind, roof, dx, dz });
    }
  }

  return { buildings, skips };
}
