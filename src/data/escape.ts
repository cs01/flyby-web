// The "Escape Pompeii" story: where you start, where each gate's road goes,
// and what is known of the people who took it. The rules are in
// sim/eruption.ts; the screens in app/escape.ts.
//
// Every historical statement here is from the excavation record or Pliny's
// letters, worded plainly. Numbers that are estimates say so.
//
// Pure (no DOM, no THREE): test/eruption.check.ts reads the routes.

import type { Route, RouteKind, Ending } from "../sim/eruption";

/** The vent: the summit of the pre-79 cone, as render/pompeii.ts's VESUVIUS. */
export const VENT = { lat: 40.8245, lon: 14.429 };

export type StartId = "bakery" | "lupanar";

export interface Start {
  id: StartId;
  title: string;
  /** Where the spawn search starts, pack metres (+x east, +z south). */
  x: number;
  z: number;
  /** A point to face: the street door. */
  faceX: number;
  faceZ: number;
  intro: string;
}

export const STARTS: Record<StartId, Start> = {
  bakery: {
    id: "bakery",
    title: "The bakery of Modestus (VII.1.36)",
    // On Via degli Augustali, the north side of insula VII.1.
    x: -97.7, z: -180.5, faceX: -101, faceZ: -186,
    intro:
      "You are a slave at the bakery of Modestus, on Via degli Augustali. " +
      "The morning's bread is in the oven (81 loaves were found in it, burnt black, " +
      "when it was dug out). It is a little before one in the afternoon.",
  },
  lupanar: {
    id: "lupanar",
    title: "The Lupanar (VII.12.18)",
    // The corner of Vicolo del Lupanare and Vicolo del Balcone Pensile.
    x: -96, z: -146, faceX: -102, faceZ: -137,
    intro:
      "You are a slave at the Lupanar, on the corner of Vicolo del Lupanare. " +
      "You have been sent out to fetch water from the fountain. " +
      "It is a little before one in the afternoon.",
  },
};

export interface GateRoute {
  gate: string;
  kind: RouteKind;
  toward: string;
  /** Metres the distance from the vent grows per metre walked. */
  radial: number;
  roadM: number;
}

/**
 * Where each gate's road leads. `radial` is how much of each step takes you
 * away from the mountain: the road to Stabiae runs nearly straight away from
 * it, the road to Herculaneum runs round its foot, the track up from the
 * Porta Vesuvio climbs toward it.
 */
export const GATE_ROUTES: GateRoute[] = [
  { gate: "Porta di Stabia", kind: "south", toward: "Stabiae", radial: 0.9, roadM: 4500 },
  { gate: "Porta Nocera", kind: "east", toward: "Nuceria", radial: 0.76, roadM: 14500 },
  { gate: "Porta Sarno", kind: "east", toward: "the Sarno valley", radial: 0.6, roadM: 9000 },
  { gate: "Porta Nola", kind: "east", toward: "Nola", radial: 0.3, roadM: 25000 },
  { gate: "Porta di Ercolano", kind: "north", toward: "Herculaneum", radial: -0.14, roadM: 16000 },
  { gate: "Porta Vesuvio", kind: "north", toward: "the farms on the mountain", radial: -0.5, roadM: 3000 },
  { gate: "Porta di Capua", kind: "north", toward: "Capua", radial: -0.2, roadM: 8000 },
  // The Porta Marina's road is a choice made at the shore: see SHORE_* below.
  { gate: "Porta Marina", kind: "shore", toward: "the harbour", radial: 0, roadM: 800 },
];

/** From the Porta Marina: south along the beach to Stabiae instead of waiting for a boat. */
export const COAST_ROUTE = { kind: "coast" as RouteKind, toward: "Stabiae, along the shore", radial: 0.85, roadM: 6300 };

/** A gate's road as the outcome model wants it, given the gate's distance from the vent. */
export function routeFor(gate: string, gateDistM: number, coast = false): Route | null {
  const g = GATE_ROUTES.find((r) => r.gate === gate);
  if (!g) return null;
  const r = coast && g.kind === "shore" ? COAST_ROUTE : g;
  return { kind: r.kind, toward: r.toward, radial: r.radial, roadM: r.roadM, gateDistM };
}

export interface EndingText {
  title: string;
  /** What happened to you. {toward} {time} {km} are filled in. */
  body: string;
  /** What is known of the people who did the same. */
  history: string;
}

export const ENDINGS: Record<Ending, EndingText> = {
  survived: {
    title: "You lived",
    body:
      "You walked out of the dark toward {toward} and kept walking. When the surges came down the " +
      "mountain at dawn you were {km} km from the crater, beyond their reach.",
    history:
      "Most of Pompeii's people seem to have done this. The town held perhaps 10,000 to 12,000 people " +
      "(estimates vary), and about 1,150 bodies have been recovered, with a third of the town still " +
      "unexcavated. Most left in the first hours of the fall, while the roads could still be walked. " +
      "Where they went is mostly unknown; family names from Pompeii turn up afterwards in " +
      "inscriptions at Naples, Cumae, Puteoli and Ostia, which may be some of them (research by the historian Steven Tuck).",
  },
  road: {
    title: "Caught on the road",
    body:
      "You left by the gate at {exit} and made for {toward}, but the pumice was deep and the night " +
      "long. The surge overtook you {km} km from the crater at {time}.",
    history:
      "Many died this way, outside the walls. Bodies have been found along the roads beyond the gates " +
      "and among the tombs that lined them. Inside the walls by the Porta Nocera, in the Garden of the " +
      "Fugitives (I.21), thirteen people, adults and children, died together on top of the pumice in " +
      "the surge, still making for the gate. Casts of them lie there today.",
  },
  town: {
    title: "The surge reached the town",
    body:
      "You were still inside the walls when the first surge to enter Pompeii came down the mountain " +
      "at {time}. It was hot, full of ash, and it moved faster than anyone could run.",
    history:
      "About 650 of the people recovered at Pompeii died in the surges, many of them in the streets " +
      "and open spaces, on top of the pumice, having come out of the houses or never left the town. " +
      "In the Garden of the Fugitives by the Porta Nocera thirteen people died together within sight " +
      "of the gate.",
  },
  roof: {
    title: "The roof gave way",
    body:
      "You sheltered indoors, as many did. At {time}, with {depth} of pumice on it, the roof came down.",
    history:
      "About 38% of the people recovered at Pompeii died during the pumice fall, before any surge, most " +
      "of them in houses whose roofs and upper floors collapsed under the weight (Luongo et al., 2003). " +
      "Sheltering kept people out of the falling stones for a few hours and then killed them.",
  },
  north: {
    title: "Toward the mountain",
    body:
      "You took the road toward {toward}, round the foot of the mountain. The surges came down that " +
      "side first. You were overtaken at {time}.",
    history:
      "Herculaneum, on the coast below the mountain, was struck in the night by the first surges. " +
      "About 300 people who had gone down to the beach, hoping for boats, died in the boat sheds and on " +
      "the sand. Just outside Pompeii's Porta Ercolano, in the Villa of Diomedes, eighteen adults and " +
      "children who sheltered in the cellar died there.",
  },
  shore: {
    title: "No boats",
    body:
      "You reached the shore and waited for a boat. None could come in: the sea was rough and full of " +
      "pumice, and the wind held it against the land. The surge reached the beach at {time}.",
    history:
      "Pliny the Younger, across the bay at Misenum, saw the sea drawn back as if by the shaking of the " +
      "ground, leaving sea creatures stranded on the sand. His uncle Pliny the Elder sailed across to " +
      "help and could not get off the beach at Stabiae; he died there on the shore the next morning. At " +
      "Herculaneum about 300 people died waiting by the boat sheds.",
  },
};

/** Shown under every ending. */
export const HISTORY_NOTE =
  "Pliny the Younger, who was 17 and watching from Misenum, wrote the only eyewitness account, in two " +
  "letters to the historian Tacitus. His manuscripts give the date as 24 August; a charcoal inscription " +
  "found in 2018 suggests it may have been October. The times in this story follow the volcanology of " +
  "Sigurdsson and others: the column at about 13:00, pumice falling on Pompeii for some eighteen hours, " +
  "and the first surge into the town at about seven the next morning.";

/** "07:05" from a local hour (27.5 is 03:30 on the second day). */
export function clockText(h: number): string {
  const m = Math.round(((h % 24) + 24) % 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}
