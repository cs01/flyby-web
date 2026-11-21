// Herculaneum's 79 AD ground as a terrain field (data/herculaneum.ts
// hercGround). Its own module so the bake, which imports the layout, does not
// pull in the DEM loader and its browser caches.

import { Heightfield } from "./dem";
import { HERC_FIELD_HALF_M, hercGround, type HerculaneumExtras } from "./herculaneum";
import type { PompeiiSuburbs } from "./pompeiisuburbs";

/**
 * At the head of the terrain's list, as render/pompeii.ts's AmphitheatreField:
 * a 30 m DEM cannot hold an 8 m sea wall, and the town is built on what this answers.
 */
export class HerculaneumField extends Heightfield {
  private readonly base: (lat: number, lon: number) => number;
  private readonly mLat: number;
  private readonly mLon: number;
  private readonly lat0: number;
  private readonly lon0: number;

  constructor(private readonly town: HerculaneumExtras, private readonly river: PompeiiSuburbs["river"] | null, lat0: number, lon0: number, fields: Heightfield[]) {
    const p = (lat0 * Math.PI) / 180;
    const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
    const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
    const R = HERC_FIELD_HALF_M;
    super({ west: lon0 - R / mLon, east: lon0 + R / mLon, south: lat0 - R / mLat, north: lat0 + R / mLat }, 1, 1);
    this.loaded = true;
    this.mLat = mLat;
    this.mLon = mLon;
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.base = (lat, lon) => {
      for (const f of fields) if (f.contains(lat, lon)) return f.sample(lat, lon);
      return fields[fields.length - 1]?.sample(lat, lon) ?? 0;
    };
  }

  override sample(lat: number, lon: number): number {
    const x = (lon - this.lon0) * this.mLon, z = (this.lat0 - lat) * this.mLat;
    return hercGround(this.town, this.river, x, z, this.base(lat, lon));
  }

  override contains(lat: number, lon: number): boolean {
    const { west, east, south, north } = this.bbox;
    return lat >= south && lat <= north && lon >= west && lon <= east;
  }
}
