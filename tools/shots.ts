// Fixed-pose screenshots, so a change to the renderer can be judged instead of
// argued about.
//
// The problem this solves: "does the city look better now" is not answerable by
// flying around, because no two flights ever put the lens in the same place, at
// the same time of day, under the same weather, at the same render scale. Every
// one of those is pinned here through query parameters the app reads
// (`?cam=`, `?t=`, `?wx=`, `?scale=`, `?shot`), so the ONLY thing that differs
// between a before and an after set is the code.
//
// Determinism comes from four places and all four are needed:
//   * `?cam=` overrides the flight model, so nothing integrates.
//   * `?t=` freezes the scene clock, so the sun does not move.
//   * `?wx=` pins the cloud decks, so today's weather is not in the picture.
//   * `?scale=` pins the adaptive resolution controller, which would otherwise
//     react to frame time and quietly change the resolution under you.
//
// The animation clock is held at zero in `?shot` mode for the same reason.
//
// Tile data is cached in a PERSISTENT Chrome profile. The first run of a pose
// downloads its DEM and imagery; every run after that reads IndexedDB, which is
// both much faster and the thing that makes two runs agree -- a re-fetched
// imagery tile can come back from a different server in the CDN pool.
//
//   bun tools/shots.ts --out shots/before
//   bun tools/shots.ts --out shots/after --only chicago-loop-night
//   bun tools/shots.ts --out shots/repeat --repeat      (determinism check)

import { mkdirSync, writeFileSync } from "node:fs";
import { Cdp } from "./cdp";

const WIDTH = 1280;
const HEIGHT = 720;

/** Clear sky, every deck at zero. Weather is not what is under test here. */
const CLEAR = "low:0:900:2100,mid:0:3800:5000,high:0:8500:9400,precip:0";

export interface Pose {
  name: string;
  /** A curated city id, or "" when the pose flies a bare coordinate. */
  city: string;
  /**
   * `lat,lon` for a place with no curated entry, written to `?at=`.
   *
   * The whole point of the live path is that a place needs no entry in
   * src/cities.ts to have buildings, so the harness has to be able to point at
   * one that has none. `?at=` outranks `?city=` in main.ts, the same way the
   * geolocation card writes it.
   */
  at?: string;
  /** Metres AMSL, not above ground: a terrain lookup would move the shot. */
  lat: number;
  lon: number;
  altM: number;
  hdgDeg: number;
  pitchDeg: number;
  /** Unix seconds. */
  t: number;
  wx: string;
  what: string;
  /**
   * An extra condition to wait for before capturing, as a JS expression.
   *
   * A pose over an unbaked place is not worth a screenshot until something has
   * actually streamed in: the frame counter says the renderer is running, not
   * that the city has arrived. Without this the harness would faithfully
   * capture an empty field and report it as the live path working.
   */
  waitFor?: { expr: string; timeoutMs: number; why: string };
}

const D = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

export const POSES: Pose[] = [
  {
    name: "sf-vanness",
    city: "sf",
    // Van Ness Avenue at Pine, looking north up the avenue toward Russian Hill.
    lat: 37.7885, lon: -122.4222, altM: 105, hdgDeg: 5, pitchDeg: -3,
    t: D("2025-06-22T02:10:00Z"), // 19:10 PDT: low evening sun across the facades
    wx: CLEAR,
    what: "SF low over Van Ness, evening sun",
  },
  {
    name: "manhattan-7th",
    city: "manhattan",
    // Seventh Avenue in the thirties, looking south down the canyon.
    lat: 40.7530, lon: -73.9905, altM: 65, hdgDeg: 209, pitchDeg: 7,
    t: D("2025-06-21T15:00:00Z"), // 11:00 EDT: high sun, one wall lit one not
    wx: CLEAR,
    what: "Manhattan in the 7th Ave canyon, late morning",
  },
  {
    name: "chicago-loop-night",
    city: "chicago",
    // Over the river north of the Loop, looking south into it.
    lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T03:30:00Z"), // 22:30 CDT: night, and the city still awake
    wx: CLEAR,
    what: "Chicago Loop at night",
  },
  {
    name: "sf-residential",
    city: "sf",
    // Pacific Heights and the Marina: block after block of three-storey
    // Victorians, which is the case a facade model gets wrong by repeating.
    lat: 37.7955, lon: -122.4340, altM: 175, hdgDeg: 285, pitchDeg: -14,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT
    wx: CLEAR,
    what: "SF residential district by day",
  },
  {
    name: "manhattan-rooftops",
    city: "manhattan",
    // Chelsea rooftops, low and shallow: the roofs fill the lower frame.
    lat: 40.7455, lon: -73.9975, altM: 95, hdgDeg: 60, pitchDeg: -11,
    t: D("2025-06-21T21:40:00Z"), // 17:40 EDT: raking light across the roofs
    wx: CLEAR,
    what: "Manhattan rooftop-level pass",
  },
  {
    name: "chicago-loop-late",
    city: "chicago",
    // The same viewpoint at half past midnight: the hour the old per-cell hash
    // looked worst, and the one the owner was looking at.
    lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T05:30:00Z"), // 00:30 CDT
    wx: CLEAR,
    what: "Chicago Loop, half past midnight",
  },
  {
    name: "emeraldhills-canopy",
    city: "emeraldhills",
    // Over Emerald Lake looking west at the wooded ridge behind Cañada College.
    // WorldCover measures this box at 55.1% tree, the highest of any city here,
    // and no other pose covers it: it is the vegetation case, and before the
    // trees existed it rendered as bare hillside under a green drape.
    lat: 37.4650, lon: -122.2650, altM: 340, hdgDeg: 250, pitchDeg: -8,
    t: D("2025-06-22T01:30:00Z"), // 18:30 PDT: raking light down the ridge
    wx: CLEAR,
    what: "Emerald Hills wooded ridge, evening",
  },
  {
    name: "emeraldhills-treetops",
    city: "emeraldhills",
    // Fifty-five metres over the wooded ridge, looking south-west at ground
    // that rises to Cañada College. Every other pose here is 300 m or higher,
    // where a whole tree is a dozen pixels and a canopy is a texture; this is
    // the only frame in the set where an individual crown is big enough to
    // judge its silhouette, its shading and its colour separately. Ground is
    // 209 m AMSL at this point (measured through terrain.heightAt), so the
    // altitude below is deliberately AGL-derived even though the field is AMSL.
    lat: 37.4630, lon: -122.2760, altM: 264, hdgDeg: 215, pitchDeg: -6,
    t: D("2025-06-22T01:30:00Z"), // 18:30 PDT, the same raking light as the ridge pose
    wx: CLEAR,
    what: "Emerald Hills treetops, 55 m above the canopy",
  },
  {
    name: "sf-street",
    city: "sf",
    // Van Ness Avenue at Pine, from the driver's seat, looking north up the
    // avenue: the same view as `sf-vanness` above from 48 m, taken from 2 m.
    //
    // Ground here measures 56.78 m AMSL through terrain.heightAt, and the field
    // below is AMSL, so 58.8 m is the carriageway plus about two metres. This
    // is the only pose in the set at eye height, and it is the one that says
    // what the ground, the kerb line and the near facades look like from a car
    // rather than from the air.
    lat: 37.7885, lon: -122.4222, altM: 58.8, hdgDeg: 5, pitchDeg: -2,
    t: D("2025-06-21T18:30:00Z"), // 11:30 PDT: the noon case, not the hero hour
    wx: CLEAR,
    what: "SF street level on Van Ness, two metres up",
  },
  {
    name: "chicago-loop-day",
    city: "chicago",
    // The same Loop as the night pose, in daylight: the pair isolates what is
    // a lighting change and what is a material change.
    lat: 41.8935, lon: -87.6290, altM: 420, hdgDeg: 178, pitchDeg: -9,
    t: D("2025-06-21T16:00:00Z"), // 11:00 CDT
    wx: CLEAR,
    what: "Chicago Loop by day",
  },
  {
    // Santa Rosa, California. Nobody has baked this and nobody is going to:
    // the point is that a place with no pack now has buildings, roads and
    // trees, fetched from OpenStreetMap while the aeroplane is in the air.
    //
    // Low and looking north up Santa Rosa Avenue into the downtown blocks, in
    // late afternoon sun so the boxes have a readable light side and a shadow
    // side rather than the flat noon wash the roadmap warns about.
    name: "santa-rosa-live",
    city: "",
    at: "38.4405,-122.7141",
    lat: 38.4330, lon: -122.7145, altM: 260, hdgDeg: 2, pitchDeg: -6,
    t: D("2025-06-22T01:40:00Z"), // 18:40 PDT
    wx: CLEAR,
    what: "Santa Rosa CA, no baked pack, streamed live from OSM",
    // The scheduler running dry, not the first tile landing: a frame captured
    // as soon as something appears is a picture of one square of a city, and
    // would look identical however much more had been on its way.
    waitFor: {
      expr: "window.flybyShot.liveBuildings > 500 && window.flybyShot.liveIdle",
      timeoutMs: 420_000,
      why: "the live OSM scheduler to run dry",
    },
  },
];

/** Extra query parameters appended to every pose, e.g. `--query terrainDebug=3`. */
let extraQuery = "";

function url(base: string, p: Pose): string {
  const q = new URLSearchParams({
    ...(p.at ? { at: p.at } : { city: p.city }),
    cam: `${p.lat},${p.lon},${p.altM},${p.hdgDeg},${p.pitchDeg}`,
    t: String(p.t),
    wx: p.wx,
    scale: "1",
    shot: "1",
    // The forecast timeline is a network fetch whose only job here would be to
    // be overridden by `?wx`, and the landmark discovery calls Wikipedia. Both
    // are left alone: they cannot change a pixel, and blocking them would be
    // one more way the harness stops resembling the app.
  });
  return `${base}/?${q.toString()}${extraQuery ? "&" + extraQuery : ""}`;
}

interface Shot {
  pose: Pose;
  file: string;
  frameMs: { mean: number; p99: number };
  triangles: number;
  trees: number;
  treeLods: number[];
  treeTriangles: number;
  lod: number;
  pavementTriangles: number;
  /** Times the detail ring restitched before the frame was taken. */
  drapeMoves: number;
  signature: number[];
}

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/** Log lines that mean the frame about to be captured is not worth capturing. */
const FATAL = [/Shader Error/i, /not compiled/i, /program not valid/i, /Uncaught/i];

async function capture(cdp: Cdp, base: string, p: Pose, outDir: string, tag: string): Promise<Shot | null> {
  cdp.problems.length = 0;
  await cdp.goto(url(base, p));
  // Two waits, not one. The first is the load (tiles, packs, shader compiles),
  // which can be a minute cold and a second warm. The second lets the frame
  // settle: the first few frames after the loop starts still have textures
  // uploading and the sun shadow cascades filling in.
  await cdp.waitFor("window.flybyShot", 240_000, `${p.name} to load`);
  await cdp.waitFor("window.flybyShot.frames > 60", 60_000, `${p.name} to settle`);
  // A street-level pose recentres the detail drape onto itself, asynchronously.
  // Capturing before that lands photographs the drape it is about to replace,
  // which is both the wrong picture and not reproducible between runs.
  // `!== true` rather than `=== false` on purpose: a build from before the
  // detail ring existed has no such field, and this harness has to be able to
  // capture the BEFORE half of a before/after pair.
  await cdp.waitFor(
    "window.flybyShot.drapePending !== true",
    120_000,
    `${p.name} detail drape`,
  );

  // A live-fetched pose additionally waits on its own condition: streamed
  // tiles arrive over the network, so there is nothing to photograph until the
  // scheduler says the ground is populated.
  //
  // That wait is allowed to FAIL without taking the run with it. Overpass is
  // volunteer infrastructure and has been refusing this machine's connections
  // for hours at a time; a pose that depends on a third party being up must not
  // be able to stop the other nine from being captured. It is skipped loudly
  // and counted, never skipped quietly, because a harness that silently drops a
  // pose reports a clean run over a hole.
  if (p.waitFor) {
    try {
      await cdp.waitFor(p.waitFor.expr, p.waitFor.timeoutMs, p.waitFor.why);
    } catch {
      console.log(
        `SKIP ${p.name.padEnd(24)} ${p.waitFor.why} never happened; ` +
          `the source it needs is unreachable from here`,
      );
      return null;
    }
  }

  await cdp.eval("window.flybyShot.resetTiming()");
  await cdp.waitFor("window.flybyShot.timed > 240", 60_000, `${p.name} timing sample`);
  const frameMs = await cdp.eval<{ mean: number; p99: number }>("window.flybyShot.frameMs()");
  const triangles = await cdp.eval<number>("window.flybyShot.triangles");
  const trees = await cdp.eval<number>("window.flybyShot.trees ?? 0");
  const treeLods = await cdp.eval<number[]>("window.flybyShot.treeLods ?? []");
  const treeTriangles = await cdp.eval<number>("window.flybyShot.treeTriangles ?? 0");
  const lod = await cdp.eval<number>("window.flybyShot.lod");
  const pavementTriangles = await cdp.eval<number>("window.flybyShot.pavementTriangles ?? 0");
  const drapeMoves = await cdp.eval<number>("window.flybyShot.drapeMoves ?? 0");
  const signature = await cdp.eval<number[]>("window.flybyShot.signature(48)");

  const bad = cdp.problems.filter((m) => FATAL.some((r) => r.test(m)));
  if (bad.length) {
    throw new Error(`${p.name}: the page is broken, refusing to screenshot it\n  ${bad[0]}`);
  }

  const dataUrl = await cdp.eval<string>("window.flybyShot.capture()");
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const file = `${outDir}/${p.name}${tag}.png`;
  writeFileSync(file, png);

  return { pose: p, file, frameMs, triangles, trees, treeLods, treeTriangles, lod, pavementTriangles, drapeMoves, signature };
}

/** Mean absolute channel difference between two frame fingerprints, 0..255. */
function signatureDiff(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function main(): Promise<void> {
  const outDir = arg("out", "shots")!;
  const only = arg("only");
  const port = Number(arg("port", "5177"));
  const debugPort = Number(arg("debug-port", "9411"));
  const profileDir = arg("profile", "/tmp/flyby-shots-profile")!;
  const repeat = has("repeat");
  extraQuery = arg("query", "") ?? "";

  mkdirSync(outDir, { recursive: true });
  const poses = only ? POSES.filter((p) => only.split(",").includes(p.name)) : POSES;
  if (!poses.length) throw new Error(`no pose matches --only ${only}`);

  // Refuse to run if something else already holds the port.
  //
  // vite exits on a --strictPort collision, and the harness then happily
  // screenshots whatever ELSE is serving there and reports plausible numbers
  // for the wrong build. That is the worst possible failure for a tool whose
  // entire job is before/after comparison: it does not error, it lies. It has
  // already cost one bogus before/after pair, when another worktree's dev
  // server was holding the default port.
  try {
    const probe = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1500),
    });
    throw new Error(
      `port ${port} is already serving (HTTP ${probe.status}). Something else is ` +
        `running there, and screenshotting it would silently measure the wrong ` +
        `build. Use --port with a free port, or stop the other server.`,
    );
  } catch (err) {
    // A connection failure is the GOOD case: nothing is listening.
    if (err instanceof Error && err.message.startsWith(`port ${port} is already`)) throw err;
  }

  const vite = Bun.spawn(["bunx", "vite", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      // Still starting.
    }
    await Bun.sleep(100);
  }

  const cdp = await Cdp.launch({
    port: debugPort,
    width: WIDTH,
    height: HEIGHT,
    profileDir,
    uncapped: true,
  });

  const shots: Shot[] = [];
  let skipped = 0;
  try {
    for (const p of poses) {
      const s = await capture(cdp, base, p, outDir, "");
      // A skipped pose is already reported by capture. Counting it here keeps
      // the summary honest about how many of the set actually landed.
      if (!s) {
        skipped++;
        continue;
      }
      shots.push(s);
      console.log(
        `${s.file.padEnd(44)} ${s.frameMs.mean.toFixed(2)} ms mean  ${s.frameMs.p99.toFixed(2)} p99  ` +
        `${(s.triangles / 1000).toFixed(0)}k tris  lod ${s.lod}  drape ${s.drapeMoves}  ` +
        `pave ${(s.pavementTriangles / 1000).toFixed(0)}k  ` +
        `trees ${s.trees} (${s.treeLods.join("/")}) ${(s.treeTriangles / 1000).toFixed(0)}k tris`,
      );
      if (repeat) {
        const again = await capture(cdp, base, p, outDir, "-repeat");
        // A pose that skipped once can skip again; there is nothing to compare.
        if (!again) continue;
        const a = Bun.file(s.file);
        const b = Bun.file(again.file);
        const identical = Buffer.from(await a.arrayBuffer()).equals(
          Buffer.from(await b.arrayBuffer()),
        );
        const diff = signatureDiff(s.signature, again.signature);
        console.log(
          `  repeat: ${identical ? "BYTE-IDENTICAL" : "differs"}, ` +
          `fingerprint delta ${diff.toFixed(3)}/255`,
        );
      }
    }
  } finally {
    cdp.close();
    vite.kill();
  }

  writeFileSync(
    `${outDir}/shots.json`,
    JSON.stringify(
      shots.map((s) => ({
        name: s.pose.name,
        what: s.pose.what,
        file: s.file,
        frameMs: s.frameMs,
        triangles: s.triangles,
        trees: s.trees,
        treeLods: s.treeLods,
        treeTriangles: s.treeTriangles,
        lod: s.lod,
        pavementTriangles: s.pavementTriangles,
        drapeMoves: s.drapeMoves,
      })),
      null,
      2,
    ),
  );
  console.log(
    `\n${shots.length} pose(s) -> ${outDir}` +
      (skipped ? `, ${skipped} SKIPPED for an unreachable source` : ""),
  );
}

await main();
