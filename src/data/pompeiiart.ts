// The Pompeian paintings and mosaics the town shows: each a tile of one
// restored atlas (tools/bake-pompeii-art.ts writes
// public/landmarks/pompeii-art/), and where it was painted or laid. The
// order here is the tile order, so render/pompeiimesh.ts can name a tile by
// index before the atlas has loaded.
//
// Pure (no DOM): the gate checks every work lands in its house.

export type ArtKind =
  /** A picture on a wall, framed: hung as one quad. */
  | "panel"
  /** A floor mosaic: one quad on the floor. */
  | "floor"
  /** A whole decorated wall (dado to cornice) repeated along a room's walls. */
  | "scheme";

export interface ArtWork {
  id: string;
  title: string;
  kind: ArtKind;
  /** The house (a `domus` name in the pack) it belongs to; "" for a scheme used generically. */
  house: string;
  /** Which room of it, in words (and the rule that places it). */
  room: string;
  /** Size on the wall or floor, metres, width x height (depth for a floor). */
  sizeM: [number, number];
  /** Ground colour shown until the atlas loads, linear-ish 0..1. */
  ground: [number, number, number];
}

export const ART_WORKS: ArtWork[] = [
  { id: "misteri-north", title: "Dionysiac frieze, north wall", kind: "panel", house: "Villa dei Misteri", room: "room 5, the long north wall", sizeM: [7, 2.7], ground: [0.55, 0.12, 0.08] },
  { id: "misteri-east", title: "Dionysiac frieze, east wall", kind: "panel", house: "Villa dei Misteri", room: "room 5, the east wall", sizeM: [5, 2.7], ground: [0.55, 0.12, 0.08] },
  { id: "vettii-ixion", title: "Punishment of Ixion", kind: "panel", house: "Casa dei Vettii", room: "triclinium off the peristyle, back wall", sizeM: [1.55, 1.7], ground: [0.5, 0.15, 0.1] },
  { id: "vettii-wall", title: "Black wall with candelabra and the frieze of cupids and psyches", kind: "scheme", house: "Casa dei Vettii", room: "the oecus off the peristyle, all walls", sizeM: [4.6, 3.2], ground: [0.08, 0.07, 0.06] },
  { id: "alexander", title: "Alexander Mosaic (Battle of Issus)", kind: "floor", house: "Casa del Fauno", room: "exedra between the two peristyles", sizeM: [5.82, 3.13], ground: [0.68, 0.6, 0.45] },
  { id: "cave-canem", title: "Cave Canem", kind: "floor", house: "Casa del Poeta Tragico", room: "the fauces, inside the front door", sizeM: [1.3, 1.0], ground: [0.55, 0.52, 0.48] },
  { id: "faun-have", title: "HAVE threshold", kind: "floor", house: "Casa del Fauno", room: "the pavement before the front door", sizeM: [1.9, 0.75], ground: [0.32, 0.32, 0.32] },
  { id: "bronzi-fourth", title: "Fourth Style wall, red, green and black", kind: "scheme", house: "Casa della Parete Nera", room: "atrium and courts", sizeM: [5.2, 4.2], ground: [0.6, 0.12, 0.08] },
  { id: "vestali-wall", title: "Fourth Style architectural wall on blue", kind: "scheme", house: "", room: "generic atrium scheme", sizeM: [4.6, 4.2], ground: [0.25, 0.4, 0.55] },
  { id: "bazzani-fourth", title: "Fourth Style architectural wall on white", kind: "scheme", house: "", room: "generic atrium scheme", sizeM: [4.4, 3.9], ground: [0.85, 0.8, 0.68] },
  { id: "seascape-black", title: "Seascape with villas on a black ground", kind: "scheme", house: "", room: "generic Third Style room", sizeM: [4.2, 3.4], ground: [0.08, 0.08, 0.08] },
  { id: "garden-room-1", title: "Garden painting (Casa del Bracciale d'Oro)", kind: "scheme", house: "", room: "generic peristyle garden wall", sizeM: [2.4, 3.3], ground: [0.2, 0.3, 0.2] },
  { id: "garden-room-2", title: "Garden painting (Casa del Bracciale d'Oro)", kind: "scheme", house: "", room: "generic peristyle garden wall", sizeM: [2.4, 3.3], ground: [0.2, 0.3, 0.2] },
];

export const ART_INDEX: Record<string, number> = Object.fromEntries(ART_WORKS.map((w, i) => [w.id, i]));

/** Schemes for an ordinary house's atrium, by its seed. */
export const ATRIUM_SCHEMES = ["vestali-wall", "bazzani-fourth", "seascape-black", "bronzi-fourth"].map((id) => ART_INDEX[id]);
/** Schemes for an ordinary house's garden walls. */
export const GARDEN_SCHEMES = ["garden-room-1", "garden-room-2"].map((id) => ART_INDEX[id]);

/** The atlas's description, written by the bake: tile rectangles in pixels and the measured ground colours. */
export interface ArtAtlas {
  size: number;
  tiles: { id: string; rect: [number, number, number, number]; ground: [number, number, number] }[];
}
