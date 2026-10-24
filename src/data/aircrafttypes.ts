// Which model and which paint a live aircraft gets, from its ICAO type code
// and callsign.
//
// The model set (tools/ai-aircraft.ts) is fifteen families. Everything else
// maps to the nearest one by shape, then by the ADS-B emitter category when
// the type is unknown. A wrong-but-close shape is the point: an A319 drawn as
// an A320 is 4 m long at 2 km, which nobody can see; an A319 drawn as a
// generic blob is what everybody can.

/** Model family ids, as tools/ai-aircraft.ts names the glbs. "heli" is built in code. */
export type Family =
  | "a320" | "a321" | "b738" | "b789" | "b77w" | "a333" | "a359" | "b763" | "b752"
  | "e175" | "crj7" | "e145" | "dh8d" | "pa28" | "cl60" | "heli";

const BY_TYPE: Record<string, Family> = {};
const map = (f: Family, codes: string) => {
  for (const c of codes.split(/\s+/)) if (c) BY_TYPE[c] = f;
};
map("a320", "A318 A319 A320 A19N A20N BCS1 BCS3 A220 B712 MD82 MD83 MD88 MD90");
map("a321", "A321 A21N");
map("b738", "B731 B732 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM");
map("b789", "B788 B789 B78X");
map("b77w", "B772 B773 B77L B77W B778 B779 B744 B748 B74F A388 A345 A346 MD11");
map("a333", "A332 A333 A338 A339 A306 A310 A30B A342 A343");
map("a359", "A359 A35K");
map("b763", "B762 B763 B764");
map("b752", "B752 B753");
map("e175", "E170 E75L E75S E175 E190 E195 E290 E295 E19X");
map("crj7", "CRJ1 CRJ2 CRJ7 CRJ9 CRJX");
map("e145", "E135 E145 E45X E35L");
map("dh8d", "DH8A DH8B DH8C DH8D AT43 AT45 AT72 AT75 AT76 SF34 SW4 JS41 B190");
map("cl60", "CL30 CL35 CL60 GLEX GL5T GL7T GLF4 GLF5 GLF6 G280 C25A C25B C25C C25M C510 C525 C550 C560 C56X C650 C680 C68A C700 C750 E50P E55P E545 E550 F2TH F900 FA7X FA8X FA50 H25B LJ35 LJ45 LJ60 LJ75 PC24 HDJT PRM1 BE40");
map("pa28", "C150 C152 C162 C170 C172 C175 C177 C182 C206 C208 C210 C72R C77R C82R C82T P28A P28B P28R P28T P32R PA22 PA24 PA32 PA34 PA44 PA46 SR20 SR22 S22T DA40 DA42 DA62 BE33 BE35 BE36 BE55 BE58 BE95 M20P M20T RV7 RV8 RV10 PC12 TBM7 TBM8 TBM9 C310 C340 C414 C421 P46T");
map("heli", "B06 B06T B407 B412 B429 B505 AS50 AS55 AS65 EC20 EC30 EC35 EC45 EC55 EC75 H60 S76 S92 R22 R44 R66 A109 A119 A139 A169 AW09 AW39 MD52 MD60 BK17 H500");

/**
 * ADS-B emitter category to a fallback family: A1 light, A2 small (12.5 to
 * 34 t, mostly business jets and regionals), A3 large (the A320/737 class),
 * A4 the 757, A5 heavy, A7 rotorcraft.
 */
const BY_CAT: Record<string, Family> = {
  A1: "pa28",
  A2: "cl60",
  A3: "a320",
  A4: "b752",
  A5: "b77w",
  A6: "b77w",
  A7: "heli",
};

export function familyFor(type: string, cat: string): Family {
  return BY_TYPE[type.toUpperCase()] ?? BY_CAT[cat.toUpperCase()] ?? "a320";
}

/**
 * Regional operators fly in a mainline brand's paint. Only the ones that fly
 * for ONE brand are here: Republic (RPA) and SkyWest (SKW) fly for three, and
 * guessing would paint a United Express jet in Delta colours a third of the
 * time, so they get the plain livery.
 */
const OPERATOR_BRAND: Record<string, string> = {
  EDV: "DAL", // Endeavor, Delta Connection
  ENY: "AAL", // Envoy, American Eagle
  PDT: "AAL", // Piedmont
  JIA: "AAL", // PSA
  ASH: "UAL", // Mesa, United Express
  GJS: "UAL", // GoJet
  UCA: "UAL", // CommutAir
  QXE: "ASA", // Horizon, Alaska
  JZA: "ACA", // Jazz, Air Canada Express
  ROU: "ACA", // Air Canada Rouge
};

/**
 * The ICAO airline prefix of a callsign ("DAL964" -> "DAL"), or "" for a
 * registration-as-callsign ("N543TH") or anything else that is not one.
 */
export function airlineOf(callsign: string): string {
  const m = /^([A-Z]{3})\d/.exec(callsign.trim().toUpperCase());
  return m ? m[1] : "";
}

/** Livery code for this callsign out of the ones a family ships, or "default". */
export function liveryFor(callsign: string, available: readonly string[]): string {
  const a = airlineOf(callsign);
  const brand = OPERATOR_BRAND[a] ?? a;
  return brand && available.includes(brand) ? brand : "default";
}
