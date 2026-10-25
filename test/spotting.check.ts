// The gate on the plane-spotting game: src/data/spotting.ts.
//
// WHAT CAN GO WRONG AND STILL PLAY. A spot that fires from 10 km away, or
// with the aircraft in a corner of the screen, or behind the camera (a
// projected point behind the lens lands mirrored in the middle of the frame);
// a hold that resets on every one-frame wobble so a phone can never take the
// photo; a logbook that counts the same airframe twice every time it flies
// past, or forgets the book when the page reloads.
//
// Every claim runs its predicate on the real case (must hold) and on a case
// built to break it (must not), so a predicate that stopped looking fails.

import { framed, spotRangeM, Hold, Logbook, rarityOf, HOLD_S, type Spot, type Store } from "../src/data/spotting";

let checks = 0;
let failures = 0;
function claim<T>(name: string, holds: (c: T) => boolean, real: T, probe: T, detail: string): void {
  checks++;
  const ok = holds(real);
  const rejected = !holds(probe);
  if (!(ok && rejected)) failures++;
  console.log(`${ok && rejected ? "  ok" : "FAIL"} ${name.padEnd(62)} ${detail}${ok ? "" : "  [real case fails]"}${rejected ? "" : "  [VACUOUS: probe passed]"}`);
}

// --- the spot condition ---------------------------------------------------------
const centre = { distM: 1200, spanM: 34, ndcX: 0.1, ndcY: -0.05, ndcZ: 0.99 };
claim("an A320 1.2 km off, near the centre, is framed", framed, centre, { ...centre, distM: 4000 }, "probe: 4 km off");
claim("one in the corner of the frame is not", (f: typeof centre) => !framed(f), { ...centre, ndcX: 0.8, ndcY: 0.7 }, centre, "corner vs centre");
claim("one behind the camera is not, however central", (f: typeof centre) => !framed(f), { ...centre, ndcZ: 1.02 }, centre, "ndc z past 1");
claim("a 65 m 777 counts from 2.5 km", framed, { ...centre, spanM: 65, distM: 2500 }, { ...centre, spanM: 10, distM: 2500 }, `range ${spotRangeM(65).toFixed(0)} m vs ${spotRangeM(10).toFixed(0)} m for a 10 m span`);

// --- the hold -------------------------------------------------------------------
const run = (pattern: (t: number) => boolean, seconds: number): boolean => {
  const h = new Hold();
  for (let t = 0; t < seconds; t += 1 / 60) if (h.update(1 / 60, pattern(t))) return true;
  return false;
};
// Lost for two frames every half second: a thumb on a phone.
const wobbly = (t: number) => (t % 0.5) > 2 / 60;
claim("a held shot with one-frame wobbles fires within 1.5 s", (p: (t: number) => boolean) => run(p, 1.5), wobbly, (t: number) => (t % 0.5) > 0.3, "probe: lost 0.3 s of every 0.5 s");
claim("and not before HOLD_S", (s: number) => !run(() => true, s), HOLD_S - 0.05, HOLD_S + 0.05, `${HOLD_S} s`);

// --- the logbook ------------------------------------------------------------------
const mem = (): Store & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};
const spot = (hex: string, type = "A321", airline = "Delta Air Lines"): Spot => ({
  hex, flight: "DAL964", reg: "N387DN", type, desc: "", airline, route: "", altFt: 3000, distM: 900,
  city: "New York", t: 0, tier: "common", points: 0,
});
{
  const store = mem();
  const book = new Logbook(store);
  const first = book.add(spot("a475a3"));
  const again = book.add(spot("a475a3"));
  claim("an airframe spotted twice counts once", (n: number) => n === 1, book.spots.length, 2, `${book.spots.length} entries, second add ${again.added ? "ADDED" : "refused"}`);
  claim("the first of a type and airline scores the bonuses", (p: number) => p === 10 + 20 + 15, first.points, 10, `${first.points} points`);
  const second = book.add(spot("a1b2c3"));
  claim("a second A321 of the same airline scores the base only", (p: number) => p === 10, second.points, 45, `${second.points} points`);
  const reloaded = new Logbook(store);
  claim("the book survives a reload", (n: number) => n === 2 && reloaded.has("a475a3"), reloaded.spots.length, new Logbook(mem()).spots.length, `${reloaded.spots.length} after reload`);
  claim("and a reload keeps the dedupe", (r: boolean) => !r, reloaded.add(spot("a475a3")).added, true, "re-adding a stored hex");
  const dup = mem();
  dup.set("flyby.logbook.v1", JSON.stringify([spot("x1"), spot("x1")]));
  claim("a stored book with a duplicate loads it once", (n: number) => n === 1, new Logbook(dup).spots.length, 2, "");
}

// --- rarity -----------------------------------------------------------------------
{
  const famous = new Set(["N628TS"]);
  const id = (type: string, cat = "A3", reg = "N1", mil = false) => ({ hex: "h", type, cat, reg, mil });
  const cases: [ReturnType<typeof id>, string][] = [
    [id("A388", "A5"), "legendary"], [id("B748", "A5"), "legendary"], [id("GLF6", "A2", "N628TS"), "legendary"],
    [id("C17", "A5", "", true), "legendary"], [id("B407", "A7"), "rare"], [id("GLF4", "A2"), "uncommon"],
    [id("B77W", "A5"), "uncommon"], [id("A321"), "common"],
  ];
  const all = (fn: typeof rarityOf) => cases.every(([a, w]) => fn(a, famous) === w);
  claim("rarity tiers by type, category, military and famous reg", all, rarityOf, () => "common", `${cases.length} cases; probe: everything common`);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
