// Gate on src/sim/mission.ts: destinations in range, par, flying voids,
// arrival, per-mode time.

import { ARRIVE_M, MAX_MISSION_M, MIN_MISSION_M, Mission, parFor, pickMission, stars, type Dest } from "../src/sim/mission";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(60)} ${detail}`);
  if (!ok) failures++;
}

const dests: Dest[] = [
  { name: "too close", x: 300, z: 0 },
  { name: "ferry building", x: 2500, z: 0 },
  { name: "too far", x: 20000, z: 0 },
];
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const picks = new Set<string>();
for (let i = 0; i < 50; i++) picks.add(pickMission(dests, 0, 0, rand)!.dest.name);
check("only destinations in range are picked", picks.size === 1 && picks.has("ferry building"), [...picks].join(","));
check("nothing in range gives null", pickMission([dests[0], dests[2]], 0, 0, rand) === null, "");
check("unstandable destination is skipped", pickMission(dests, 0, 0, rand, () => false) === null, "");
check("range bounds are sane", MIN_MISSION_M < MAX_MISSION_M, "");

// Walking 2.5 km at 1.4 m/s must miss par: the game is to catch a vehicle.
const walkS = 2500 / 1.4;
check("pure walking misses par over 2.5 km", walkS > parFor(2500), `walk ${walkS.toFixed(0)} s, par ${parFor(2500)} s`);
check("a 9 m/s ride makes par", 2500 / 9 + 300 < parFor(2500), `par ${parFor(2500)} s`);

const spec = pickMission(dests, 0, 0, rand)!;
let m = new Mission(spec);
m.update(60, "walk", 100, 0);
m.update(120, "ride", 1500, 0);
check("still running away from the goal", m.state === "running", m.state);
m.update(10, "walk", 2500 - ARRIVE_M + 1, 0);
check("arrives inside the radius", m.state === "arrived", m.state);
check("per-mode seconds add up", m.legs.get("walk") === 70 && m.legs.get("ride") === 120 && m.elapsedS === 190, JSON.stringify([...m.legs]));
m.update(100, "walk", 0, 0);
check("clock stops on arrival", m.elapsedS === 190, `${m.elapsedS}`);

m = new Mission(spec);
m.update(10, "walk", 0, 0);
check("taking off voids the run", m.update(1, "plane", 0, 0) === "void", "");
m = new Mission(spec);
check("the drone voids it too", m.update(1, "drone", 0, 0) === "void", "");
// Vacuity: a mission that starts on its destination must arrive at once.
check("probe: start on the goal arrives", new Mission(spec).update(0, "walk", spec.dest.x, spec.dest.z) === "arrived", "");

check("stars: at par is 3", stars(100, 100) === 3, "");
check("stars: 1.4x par is 2", stars(140, 100) === 2, "");
check("stars: 2x par is 1", stars(200, 100) === 1, "");

if (failures) {
  console.log(`${failures} mission check(s) failed`);
  process.exit(1);
}
console.log("mission: all checks pass");
