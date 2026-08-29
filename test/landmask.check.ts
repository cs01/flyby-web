// The gate on the landcover masks the terrain shader samples.
//
// A format check on these would be worthless: the packing is trivial and any
// wiring mistake produces a perfectly well-formed RGBA8 grid. The only thing
// that can catch a swapped channel, a transposed index or a half-texel offset
// is GEOGRAPHY, so this asserts what is at named coordinates, through the same
// bilinear filter the GPU runs (sampleMaskBilinear is the oracle precisely
// because it is the maths in the shader, not a second opinion about it).
//
// The Lake Michigan probe is the reason the phase exists. That water sits at
// 176 m, and the old rule `smoothstep(3.5, 0.4, elevation)` is anchored to sea
// level, so it called Chicago's whole lakefront lit land. The two are printed
// side by side below, and if that contrast ever stops being visible in this
// output, the check has stopped testing the thing it was written for.
//
// Watched to fail: swapping the water and built entries in the
// CHANNEL_OF_CLASS table in src/data/landmask.ts turns every water and every
// built assertion red at once.

import { parseLandPack, type LandPack } from "../src/data/landcover";
import { buildLandMaskRGBA, sampleMaskBilinear } from "../src/data/landmask";
import { Origin } from "../src/geo";

const DIR = "public/cities";

type Channel = "water" | "built" | "veg" | "bare";

interface Probe {
  city: string;
  name: string;
  lat: number;
  lon: number;
  /** Channel, comparison, threshold. Every one must hold. */
  want: [Channel, ">" | "<", number][];
}

/**
 * Points chosen from what is actually on the ground, not from what the packs
 * happen to say. Each one is deep inside a feature hundreds of metres across,
 * so a 10 m posting cannot be ambiguous about it and the assertion is not
 * riding on the exact shoreline.
 */
const PROBES: Probe[] = [
  {
    city: "chicago",
    name: "Lake Michigan, ~2.5 km offshore of Grant Park",
    lat: 41.885, lon: -87.58,
    want: [["water", ">", 0.9]],
  },
  {
    city: "chicago",
    name: "the Loop",
    lat: 41.8827, lon: -87.6295,
    want: [["built", ">", 0.5], ["water", "<", 0.1]],
  },
  {
    city: "manhattan",
    name: "mid-Hudson off W 42nd St",
    lat: 40.758, lon: -74.013,
    want: [["water", ">", 0.9]],
  },
  {
    city: "manhattan",
    name: "Central Park, Sheep Meadow",
    lat: 40.7715, lon: -73.974,
    want: [["veg", ">", 0.5], ["built", "<", 0.35]],
  },
  {
    city: "sf",
    name: "San Francisco Bay, mid-channel north of the Bay Bridge",
    lat: 37.81, lon: -122.378,
    want: [["water", ">", 0.9]],
  },
  {
    city: "sf",
    name: "Financial District",
    lat: 37.793, lon: -122.4,
    want: [["built", ">", 0.5]],
  },
];

/** GLSL smoothstep, edges either way round. The shader's old water test. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Lake Michigan's surface, metres above sea level. */
const LAKE_MICHIGAN_M = 176;

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}

const packs = new Map<string, LandPack>();
async function pack(id: string): Promise<LandPack | null> {
  if (!packs.has(id)) {
    const file = Bun.file(`${DIR}/${id}.land`);
    if (!(await file.exists())) return null;
    packs.set(id, parseLandPack(await file.arrayBuffer()));
  }
  return packs.get(id) ?? null;
}

for (const p of PROBES) {
  const lp = await pack(p.city);
  if (!lp) {
    // A missing pack is a failure here, not a skip. Skipping is how a gate
    // quietly stops checking anything at all.
    check(`${p.city}: ${p.name}`, false, `no ${DIR}/${p.city}.land -- run: bun tools/bake-land.ts --all`);
    continue;
  }
  const level = lp.levels[0];
  const rgba = buildLandMaskRGBA(level);
  const origin = new Origin(lp.lat0, lp.lon0);
  const w = origin.toWorld(p.lat, p.lon);
  const s = sampleMaskBilinear(rgba, level.n, level.extentM, w.x, w.z);

  const shown =
    `water ${s.water.toFixed(3)} built ${s.built.toFixed(3)} ` +
    `veg ${s.veg.toFixed(3)} bare ${s.bare.toFixed(3)}`;
  for (const [ch, cmp, thr] of p.want) {
    const v = s[ch];
    const ok = cmp === ">" ? v > thr : v < thr;
    check(`${p.city}: ${p.name}`, ok, `${ch} ${v.toFixed(3)} ${cmp} ${thr}   [${shown}]`);
  }

  // One-hot in, so bilinear out must still be a partition of unity. This is
  // what catches a class silently landing in no channel at all, which every
  // per-channel threshold above would happily pass.
  const sum = s.water + s.built + s.veg + s.bare;
  check(`${p.city}: ${p.name} channels sum to 1`, Math.abs(sum - 1) < 0.01, `sum ${sum.toFixed(4)}`);
}

// The comparison the whole phase is about, printed rather than merely asserted.
const oldRule = smoothstep(3.5, 0.4, LAKE_MICHIGAN_M);
const lakeProbe = PROBES[0];
const lakePack = await pack(lakeProbe.city);
let lakeWater = NaN;
if (lakePack) {
  const level = lakePack.levels[0];
  const origin = new Origin(lakePack.lat0, lakePack.lon0);
  const w = origin.toWorld(lakeProbe.lat, lakeProbe.lon);
  lakeWater = sampleMaskBilinear(buildLandMaskRGBA(level), level.n, level.extentM, w.x, w.z).water;
}
console.log(
  `\nLake Michigan at ${LAKE_MICHIGAN_M} m:\n` +
    `  old elevation rule smoothstep(3.5, 0.4, ${LAKE_MICHIGAN_M}) = ${oldRule.toFixed(4)}  (shades as lit land)\n` +
    `  landcover water                                   = ${lakeWater.toFixed(4)}`,
);
check("old elevation rule misses Lake Michigan", oldRule < 0.001, `${oldRule.toFixed(4)} < 0.001`);
check("landcover catches Lake Michigan", lakeWater > 0.9, `${lakeWater.toFixed(4)} > 0.9`);

console.log(failures === 0 ? "\nall landmask probes ok" : `\n${failures} landmask check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
