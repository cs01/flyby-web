import { solarState } from "../src/data/solar";
const cases: [string, number, number, string][] = [
  ["SF solar noon-ish", 37.7749, -122.4194, "2026-08-28T20:00:00Z"],
  ["SF midnight",       37.7749, -122.4194, "2026-08-28T09:00:00Z"],
  ["Equator equinox noon", 0, 0,            "2026-03-20T12:00:00Z"],
  ["Reykjavik summer 2am", 64.14, -21.94,   "2026-06-21T02:00:00Z"],
  ["Sydney winter noon", -33.87, 151.21,    "2026-06-21T02:00:00Z"],
];
for (const [n, lat, lon, t] of cases) {
  const s = solarState(new Date(t), lat, lon);
  console.log(n.padEnd(24), "sun alt", s.sun.altitude.toFixed(2).padStart(7),
    "az", s.sun.azimuth.toFixed(1).padStart(6),
    "| daylight", s.daylight.toFixed(2),
    "| moon alt", s.moon.altitude.toFixed(1).padStart(6), "phase", s.moonPhase.toFixed(2));
}
