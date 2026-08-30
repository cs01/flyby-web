// Reader and writer for the binary .street packs: the individually mapped
// street furniture of a city.
//
// WHY A SIBLING PACK AND NOT A SECTION OF .roads. A road pack is a list of ways
// and a furniture pack is a list of nodes; putting the second inside the first
// would either bump the .roads version (and break every already-baked pack) or
// bolt an optional trailer onto a format whose whole virtue is that it is
// fields written back to back with no negotiation. A city can have roads and no
// furniture, which is the common case, and a missing sibling file is a cleaner
// way to say that than a zero-length section.
//
// WHAT IS IN IT AND WHY IT IS WORTH FETCHING. OSM maps street furniture as
// individual nodes with real coordinates, and in a well-mapped city there are
// thousands of them: 2,461 street lamps, 3,564 trees, 714 benches and 506 bins
// in a 1.7 x 2.5 km box of Paris, against 35 nodes of anything in a suburb.
// Where the surveyors have been, a bench can stand where a bench stands. Where
// they have not, the renderer places procedurally and says so; see
// data/streetfurniture.ts.
//
// Same shape as roadpack.ts on purpose: little-endian, no alignment padding,
// and PURE, so tools/verify-roads.ts can run the browser's own parser over the
// baker's output under Bun.

export const STREET_MAGIC = 0x53545254; // "STRT"
const STREET_VERSION = 1;
const STREET_HEADER_BYTES = 32;
const STREET_RECORD_BYTES = 10;

export enum FurnitureKind {
  StreetLamp = 0,
  TrafficSignal = 1,
  Bench = 2,
  WasteBasket = 3,
  FireHydrant = 4,
}

export const FURNITURE_KIND_NAMES: string[] = [
  "street_lamp", "traffic_signal", "bench", "waste_basket", "fire_hydrant",
];

/** Every legal code, for the verifier. Derived from the name table so a kind
 *  cannot be added to one and forgotten in the other. */
export const FURNITURE_KIND_CODES: number[] = FURNITURE_KIND_NAMES.map((_, i) => i);

/**
 * The `direction` byte, when a node carries no usable one.
 *
 * A bench faces somewhere and a traffic signal points at the traffic it stops,
 * and OSM records that on a minority of nodes. 255 is the sentinel rather than
 * 0, because 0 is a perfectly good bearing (due north) and a sentinel that is
 * also a legal value is how a whole city ends up facing the same way.
 */
export const DIRECTION_UNKNOWN = 255;

export interface Furniture {
  kind: FurnitureKind;
  /** Bearing in degrees clockwise from north, or null when not mapped. */
  directionDeg: number | null;
  /** Local ENU metres, the same frame the .roads pack uses. */
  x: number;
  z: number;
}

export interface StreetPack {
  lat0: number;
  lon0: number;
  radiusM: number;
  items: Furniture[];
}

export function encodeStreetPack(
  items: readonly Furniture[],
  lat0: number,
  lon0: number,
  radiusM: number,
): Uint8Array {
  const buf = new ArrayBuffer(STREET_HEADER_BYTES + STREET_RECORD_BYTES * items.length);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, STREET_MAGIC, true); o += 4;
  dv.setUint32(o, STREET_VERSION, true); o += 4;
  dv.setFloat64(o, lat0, true); o += 8;
  dv.setFloat64(o, lon0, true); o += 8;
  dv.setFloat32(o, radiusM, true); o += 4;
  dv.setUint32(o, items.length, true); o += 4;

  for (const it of items) {
    dv.setUint8(o, it.kind); o += 1;
    dv.setUint8(
      o,
      it.directionDeg === null
        ? DIRECTION_UNKNOWN
        // 256ths of a turn, and never the sentinel: a bearing that quantises to
        // 255 is 358.6 degrees, which is worth one and a half degrees of error
        // to keep "unknown" unambiguous.
        : Math.min(254, Math.max(0, Math.round((((it.directionDeg % 360) + 360) % 360) / 360 * 256) % 256)),
    );
    o += 1;
    dv.setFloat32(o, it.x, true); o += 4;
    dv.setFloat32(o, it.z, true); o += 4;
  }
  return new Uint8Array(buf);
}

export function parseStreetPack(buf: ArrayBuffer): StreetPack {
  const dv = new DataView(buf);
  let o = 0;
  const magic = dv.getUint32(o, true); o += 4;
  if (magic !== STREET_MAGIC) {
    throw new Error(`not a .street pack (magic 0x${magic.toString(16)})`);
  }
  const version = dv.getUint32(o, true); o += 4;
  if (version !== STREET_VERSION) throw new Error(`unsupported .street version ${version}`);
  const lat0 = dv.getFloat64(o, true); o += 8;
  const lon0 = dv.getFloat64(o, true); o += 8;
  const radiusM = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;

  const items: Furniture[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const kind = dv.getUint8(o); o += 1;
    const dir = dv.getUint8(o); o += 1;
    const x = dv.getFloat32(o, true); o += 4;
    const z = dv.getFloat32(o, true); o += 4;
    items[i] = {
      kind,
      directionDeg: dir === DIRECTION_UNKNOWN ? null : (dir / 256) * 360,
      x,
      z,
    };
  }
  return { lat0, lon0, radiusM, items };
}

/** How many of each kind a pack holds, for the bake report and the console. */
export function furnitureHistogram(items: readonly Furniture[]): [string, number][] {
  const counts = new Map<number, number>();
  for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => [FURNITURE_KIND_NAMES[k] ?? `?${k}`, n] as [string, number]);
}
