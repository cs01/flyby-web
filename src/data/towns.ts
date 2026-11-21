// The ancient towns FLYBY rebuilds on their excavated plans, and what differs
// between them. Pompeii and Herculaneum share one pack format
// (data/pompeii.ts), one builder (render/pompeiimesh.ts) and one shader; a
// TownDef says what each town's pack is called and the few things the shared
// systems do differently there. Pompeii's values are the ones the builder
// always used, so leaving `town` out of a pack builds Pompeii exactly as before.
//
// Pure: no DOM, no THREE.

export type TownId = "pompeii" | "herculaneum";

export interface TownStyle {
  /** Added to the rule-built lots' chance of an upper floor. */
  upperStorey: number;
  /** Chance a two-storey street front carries a timber balcony. */
  balcony: number;
  /**
   * Timber in the upper storeys: dark beams, overhanging floors, opus
   * craticium (a timber frame with rubble infill). Herculaneum's carbonised
   * wood survives where Pompeii's burnt away, which is why we know it was there.
   */
  timber: boolean;
}

export interface TownDef {
  id: TownId;
  /** The City entry's id (cities.ts). */
  cityId: string;
  /** public/landmarks/<pack> */
  pack: string;
  /** A fortified circuit with towers and gates; false draws no wall round the town ring. */
  walled: boolean;
  style: TownStyle;
  /**
   * The eruption as this town met it, for render/eruption.ts. `fall` scales
   * the pumice laid in the streets (Pompeii's record is 1); `surgeH` is the
   * local hour the first surge to reach the town arrived.
   */
  eruption: { fall: number; surgeH: number };
}

export const TOWNS: Record<TownId, TownDef> = {
  pompeii: {
    id: "pompeii", cityId: "pompeii", pack: "pompeii.json", walled: true,
    style: { upperStorey: 0, balcony: 0.4, timber: false },
    // S4 at about 07:30 on the second morning (sim/eruption.ts).
    eruption: { fall: 1, surgeH: 31.5 },
  },
  herculaneum: {
    id: "herculaneum", cityId: "herculaneum", pack: "herculaneum.json",
    // The town had a wall, but by 79 its sea front was built over by the
    // terraces and the Suburban Baths; the landward circuit is not excavated.
    walled: false,
    // Herculaneum's houses keep their upper floors: most street fronts in the
    // excavated insulae are two storeys, many with balconies and overhangs.
    style: { upperStorey: 0.4, balcony: 0.7, timber: true },
    // The plume blew south-east, so Herculaneum had only a few centimetres
    // of ash fall; the first surge (S1) reached the shore at about 01:00.
    eruption: { fall: 0.04, surgeH: 25.0 },
  },
};

export function townDef(id: TownId | undefined): TownDef {
  return TOWNS[id ?? "pompeii"];
}

/** The town a City entry rebuilds, or null for a modern city. */
export function townForCity(cityId: string): TownDef | null {
  for (const t of Object.values(TOWNS)) if (t.cityId === cityId) return t;
  return null;
}
