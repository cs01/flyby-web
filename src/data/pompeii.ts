// Pompeii's baked layout: the walled town as streets, insulae and public
// buildings, in local metres about the pack's own origin. Written by
// tools/bake-pompeii.ts from one cached Overpass answer, read by
// render/pompeii.ts and test/pompeii.check.ts.
//
// Pure (no DOM, no THREE): the gate builds the town from this under Bun.

/** x,z pairs, world metres (+x east, +z south) about the pack origin. */
export type Ring = number[];

export interface PompeiiStreet {
  name: string;
  /** A decumanus or cardo: wide, paved, lined with shops. */
  main: boolean;
  /** Carriageway width between the kerbs, metres. */
  carriageM: number;
  /** Raised pavement each side, metres. */
  sidewalkM: number;
  /** Not in OSM: a vicolo laid through an unexcavated block on the known grid. */
  inferred: boolean;
  pts: number[];
}

export interface PompeiiInsula {
  /** Building frontage line: the back of the pavement. */
  ring: Ring;
  /** The kerb line: the insula plus its share of pavement. */
  kerb: Ring;
  /**
   * Unexcavated in 2026 (regio V north, I/IX east, III/IV): the houses are
   * generated on the excavated pattern, not drawn from a survey.
   */
  inferred: boolean;
  /** Mostly vineyard or garden in OSM (the Foro Boario, the regio II plots). */
  garden: boolean;
  /** Indices of the ring edges that face a main street, for the shopfronts. */
  mainEdges: number[];
}

export type PublicKind =
  | "forum" | "temple" | "basilica" | "hall" | "baths" | "theatre" | "odeon"
  | "portico" | "palestra" | "amphitheatre";

export interface PompeiiPublic {
  name: string;
  kind: PublicKind;
  ring: Ring;
}

export interface PompeiiGate {
  name: string;
  x: number;
  z: number;
}

export interface PompeiiPlace {
  name: string;
  x: number;
  z: number;
  kind: "domus" | "gate" | "public";
}

export interface PompeiiAmphitheatre {
  cx: number;
  cz: number;
  /** Semi-axes, metres, outer wall. */
  a: number;
  b: number;
  /** Major-axis bearing in the x,z plane, radians from +x. */
  rot: number;
}

export interface PompeiiData {
  lat0: number;
  lon0: number;
  wall: Ring;
  gates: PompeiiGate[];
  streets: PompeiiStreet[];
  insulae: PompeiiInsula[];
  publics: PompeiiPublic[];
  amphitheatre: PompeiiAmphitheatre;
  places: PompeiiPlace[];
  /** Real domus outlines from OSM, used as explicit lots where they fit. */
  domus: { name: string; ring: Ring }[];
  stats: Record<string, number>;
}

export function parsePompeii(text: string): PompeiiData {
  const d = JSON.parse(text) as PompeiiData;
  if (!Array.isArray(d.streets) || !Array.isArray(d.insulae) || !Array.isArray(d.wall)) {
    throw new Error("pompeii: not a pompeii pack");
  }
  return d;
}

// --- small geometry shared by the baker, the renderer and the gate ----------

export function ringArea(r: Ring): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return a / 2;
}

export function pointInRing(r: Ring, x: number, z: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringCentroid(r: Ring): [number, number] {
  let x = 0, z = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) { x += r[i * 2]; z += r[i * 2 + 1]; }
  return [x / n, z / n];
}

export function polylineLength(p: number[]): number {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

/** Display name without the regio.insula.door address OSM carries. */
export function plainName(n: string): string {
  return n.replace(/\s*\(?\b[IVX]+\.\d+(\.[\dA-Z-]+)?\)?\s*$/, "").replace(/\s+/g, " ").trim();
}
