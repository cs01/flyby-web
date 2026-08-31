// Bootstrap: load a place, build the world, fly it.
//
// Load order is deliberate. Weather and terrain are fetched CONCURRENTLY and
// the terrain mesh waits only on the DEM, because the DEM is the long pole
// (dozens of PNG tiles) and the weather is one small JSON. Serialising them
// would add the weather latency to the load for no reason.

import * as THREE from "three";
import { createRenderer, createSceneTarget } from "./render/renderer";
import { AdaptiveQuality } from "./render/quality";
import { Sky } from "./render/sky";
import { Terrain } from "./render/terrain";
import { deviceBudget } from "./render/budget";
import { computeLighting } from "./render/lighting";
import { loadHeightfield, bboxAround, type Heightfield } from "./data/dem";
import { stitchImagery, type StitchedImage } from "./data/imagery";
import { fetchWeather, fetchForecast, beamOpacity, type Weather } from "./data/weather";
import { clearCache } from "./data/cache";
import { showDiagnostics, watchForFailures } from "./app/diag";
import { solarState, sceneTime } from "./data/solar";
import { Origin } from "./geo";
import { CITIES, cityById, cityAt, DEFAULT_CITY, type City } from "./cities";
import { Hud, LoadingScreen } from "./app/hud";
import { showMenu } from "./app/menu";
import { Aircraft, DEFAULT_CONFIG, EASY_CONFIG, chooseStartAltitude } from "./sim/aircraft";
import { ChaseCam, CAMERA_MODES } from "./sim/chasecam";
import { Drone, DRONE_RADIUS } from "./sim/drone";
import { Car, CAR_NEAR_PLANE_M } from "./sim/car";
import { buildRoadGraph } from "./data/roadgraph";
import { DetailRing } from "./render/detailring";
import { CityCollision } from "./sim/citycollision";
import { Input } from "./sim/input";
import { AircraftModel } from "./render/aircraftmodel";
import { Osd } from "./app/osd";
import { Minimap } from "./app/minimap";
import { Timebar, LocalClock } from "./app/timebar";
import { Beacon } from "./render/beacon";
import { loadCityPack } from "./data/citypack-load";
import { Buildings } from "./render/buildings";
import { hourFactors } from "./render/facade";
import { buildUrbanMask, emptyUrbanMask, type UrbanMask } from "./render/urbanmask";
import { loadLandPack } from "./data/landcover-load";
import { loadRoadPack } from "./data/roadpack-load";
import { loadStreetPack } from "./data/streetpack-load";
import { FurnitureKind } from "./data/streetpack";
import { PointIndex, LAMP_SNAP_M, type StreetWorld } from "./data/streetfurniture";
import { Roads } from "./render/roads";
import { Pavement } from "./render/pavement";
import { isCarriageway } from "./data/pavement";
import { roadWidthM, RoadClass } from "./data/roadpack";
import {
  trafficState,
  localHour,
  utcOffsetFromLongitude,
  CLASS_COUNT,
} from "./data/trafficmodel";
import { StreetLamps, LAMP_TRIANGLES } from "./render/streetlamps";
import type { StreetLampUniforms } from "./render/streetlamps";
import { ParkedCars, Traffic, CAR_TRIANGLES } from "./render/traffic";
import { buildLandMask, emptyLandMask, type LandMask } from "./render/landmask";
import { Foliage, TREE_LOD_TRIANGLES } from "./render/trees";
import { buildLandMaskRGBA } from "./data/landmask";
import { CompositeRoadIndex, FootprintMask, RoadIndex, treeRoadClearanceM } from "./data/trees";
import { LiveVegetation } from "./data/osmveg";
import { bakedCityCoverage, LiveWorld, LIVE_EXTENT_M } from "./app/live";
import { Overpass } from "./data/overpass";
import type { DataSource } from "./app/hud";
import type { BuildingUniforms } from "./render/buildings";
import type { RoadUniforms } from "./render/roads";
import { Composite } from "./render/composite";
import { AoPass } from "./render/ao";
import { SunShadow } from "./render/sunshadow";
import { SkyProbe } from "./render/skyprobe";
import { Skyline } from "./sim/skyline";
import { reverseGeocode, placeLabel } from "./data/place";
import { Labels } from "./app/labels";
import { Layers } from "./app/layers";
import { Places, type PlaceRow } from "./app/places";
import { Autopilot } from "./sim/autopilot";
import { fetchNearby, searchNamedPlaces } from "./data/nearby";

function chooseCity(): City | null {
  const params = new URLSearchParams(location.search);
  // `?at=lat,lon` outranks `?city=`: it is the more specific request, and it is
  // what the geolocation card writes.
  const at = params.get("at");
  if (at) {
    const [lat, lon] = at.split(",").map(Number);
    // A malformed `at` must fall through to the menu rather than flying to
    // NaN, which loads a black world and never says why.
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      return cityAt(lat, lon);
    }
  }
  const q = params.get("city");
  if (!q) return null;
  return cityById(q) ?? cityById(DEFAULT_CITY) ?? CITIES[0];
}

/**
 * Picking a city reloads the page rather than swapping the scene in place.
 *
 * Everything in the world -- the two height fields, three stitched drapes, the
 * building pack, the tangent-plane origin every coordinate is relative to -- is
 * built once per city and threaded through the whole renderer. Tearing that
 * down and rebuilding it correctly is a large amount of teardown code whose
 * only reward is skipping a page load that is already fast, because every tile
 * the new city needs comes out of the same IndexedDB cache on the way back.
 */
function goToCity(city: City): void {
  const params = new URLSearchParams(location.search);
  params.delete("at");
  params.set("city", city.id);
  location.search = params.toString();
}

/**
 * `?wx=low:0.95:900:2100,mid:0:3800:5000,high:0:8500:9400,precip:0` pins the
 * cloud fields to exact numbers, so a sky that renders badly can be reproduced
 * on any machine on any day. Each deck is `cover:base:top`, cover 0..1 and the
 * heights in metres AMSL; any term may be left out and keeps the observed
 * value. Everything the decks do not name (temperature, wind, the sun) is still
 * the real observation, and while `?wx` is set the forecast timeline no longer
 * drives cloud: a pinned sky that drifted with the clock would not be a repro.
 */
function wxOverride(observed: Weather): Weather | null {
  const spec = new URLSearchParams(location.search).get("wx");
  if (!spec) return null;

  // Everything the shading reads is pinned, not just the decks.
  //
  // This used to be `{...observed}` with only the named decks replaced, which
  // left temperature, wind and precipitation as the LIVE observation. Those
  // feed wetness, lying snow and the sun tint, so the screenshot harness was
  // reproducible back to back and drifted over hours: a build rendered today
  // could not be compared byte for byte against the same build rendered
  // yesterday, which is the one thing the harness exists to do. Measured: the
  // same commit, same pose, thirty minutes apart, produced different bytes,
  // while two runs a minute apart were identical.
  //
  // A pinned sky has to pin the whole sky.
  const out: Weather = {
    ...observed,
    source: "simulated",
    tempC: 15,
    dewC: 8,
    humidity: 0.63,
    pressureHpa: 1013,
    windSpeed: 4,
    windDir: 270,
    gust: 6,
    precip: 0,
    precipKind: "none",
    visibility: 20000,
  };
  for (const term of spec.split(",")) {
    const f = term.split(":");
    const num = (i: number, fallback: number): number => {
      const v = Number(f[i]);
      return f.length > i && f[i] !== "" && Number.isFinite(v) ? v : fallback;
    };
    const key = f[0];
    if (key === "precip") {
      out.precip = Math.max(0, num(1, out.precip));
    } else if (key === "low" || key === "mid" || key === "high") {
      const deck = out[key];
      out[key] = {
        cover: Math.max(0, Math.min(1, num(1, deck.cover))),
        base: num(2, deck.base),
        top: num(3, deck.top),
      };
    }
  }

  // The decks stack as independent layers, the same way the beam attenuation
  // does, so a 50% low under a 50% mid reads as 75% of the sky covered.
  out.totalCover =
    1 - (1 - out.low.cover) * (1 - out.mid.cover) * (1 - out.high.cover);
  out.opacity = beamOpacity(out.low.cover, out.mid.cover, out.high.cover);
  return out;
}

/**
 * A pinned camera: `?cam=lat,lon,altM,headingDeg,pitchDeg`.
 *
 * The screenshot harness has to put the lens in exactly the same place across
 * two builds or the comparison is worthless, and there is no way to do that by
 * flying. Altitude is metres AMSL rather than above ground, because AMSL is a
 * number and "above ground" is a terrain lookup that would move the shot if the
 * DEM cache came back with a different tile.
 */
interface PinnedCam {
  lat: number;
  lon: number;
  altM: number;
  hdgDeg: number;
  pitchDeg: number;
}

function pinnedCam(): PinnedCam | null {
  const spec = new URLSearchParams(location.search).get("cam");
  if (!spec) return null;
  const f = spec.split(",").map(Number);
  if (f.length < 5 || !f.every((v) => Number.isFinite(v))) return null;
  return { lat: f[0], lon: f[1], altM: f[2], hdgDeg: f[3], pitchDeg: f[4] };
}

/** Three decimals is ~110 m: enough to fly, not enough to be an address. */
function goToCoords(lat: number, lon: number): void {
  const params = new URLSearchParams(location.search);
  params.delete("city");
  params.set("at", `${lat.toFixed(3)},${lon.toFixed(3)}`);
  location.search = params.toString();
}

async function main() {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const ui = document.getElementById("ui")!;
  const loading = new LoadingScreen();

  // A black screen on a phone is unreportable without these: `?diag=1` prints
  // what the device actually supports, and the failure watch surfaces a lost
  // context or a post-boot throw on screen instead of only in a console nobody
  // on a phone can open.
  const diagCanvas = document.getElementById("view") as HTMLCanvasElement;
  watchForFailures(diagCanvas);
  if (new URLSearchParams(location.search).has("diag")) {
    showDiagnostics(document.createElement("canvas"));
  }

  // The device tier, decided once and before anything allocates. Every number
  // that follows from it (the drape plan, MSAA, the cascades, the aircraft's
  // probes, ambient occlusion, both triangle budgets) comes out of this one
  // object, and `?diag=1` prints the memory total it adds up to.
  const budget = deviceBudget();
  console.log(
    `[flyby] device tier: ${budget.tier}` +
    `${budget.reasons.length ? ` (${budget.reasons.join("; ")})` : ""}, ` +
    `~${(budget.memory.totalBytes / 1048576).toFixed(0)} MB of GPU memory planned`,
  );

  const city = chooseCity();
  if (!city) {
    loading.done();
    showMenu(goToCity, goToCoords);
    return;
  }
  const origin = new Origin(city.lat, city.lon);

  // The scene clock. `base` is the instant the session started from; the
  // scrubber and the timelapse both move an OFFSET from it rather than
  // rewriting it, so "back to now" is one assignment and cannot drift.
  const base = sceneTime();
  const frozen = new URLSearchParams(location.search).has("t");
  const startPerf = performance.now();
  let clockOffset = 0;
  let timelapse = false;
  // 600x: a full day passes in 2 minutes 24 seconds, which is slow enough to
  // watch a sunset happen and fast enough not to be a waiting game.
  const TIMELAPSE_RATE = 600;
  const sceneNow = (): Date => {
    const real = frozen ? 0 : (performance.now() - startPerf) / 1000;
    return new Date(base.getTime() + (real + clockOffset) * 1000);
  };
  let now = base;

  loading.set(0.04, `contacting weather for ${city.name}`);

  // Weather first-but-not-blocking: kick it off, then start the heavy fetches.
  // The forecast rides along with it: it is one more small JSON, it is what
  // makes the clock worth moving, and fetching it later would put a stall in
  // the middle of a flight.
  const wxPromise = fetchWeather(city.lat, city.lon);
  const forecastPromise = fetchForecast(city.lat, city.lon);

  // DEM: a near field at SRTM-native resolution and a far one for the horizon.
  // z12 is ~30 m/px, which is exactly SRTM's own posting, so a higher zoom
  // would only interpolate and cost four times the tiles.
  loading.set(0.08, "loading terrain");
  let demDone = 0;
  const demTotalGuess = 45;
  const bump = () => loading.set(0.08 + 0.34 * Math.min(1, ++demDone / demTotalGuess), "loading terrain");

  const fields: Heightfield[] = await Promise.all([
    loadHeightfield(bboxAround(city.lat, city.lon, 22000), 12, bump),
    loadHeightfield(bboxAround(city.lat, city.lon, 80000), 9, bump),
  ]);

  loading.set(0.44, "loading imagery");
  let imgDone = 0;
  const drapes: StitchedImage[] = [];
  const rings = budget.rings;
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    drapes.push(await stitchImagery(bboxAround(city.lat, city.lon, ring.extent * 1.05), ring.imageryZoom));
    loading.set(0.44 + 0.4 * (++imgDone / rings.length), "loading imagery");
  }

  loading.set(0.88, "building world");
  const { renderer, scene, camera } = createRenderer(canvas, budget);

  // A failed shader is invisible on a phone: three.js logs and carries on, and
  // the mesh either vanishes or draws garbage. Surface it in the same red box
  // the context-loss watch uses.
  renderer.debug.onShaderError = (gl, _prog, vs, fs) => {
    const shout = (window as unknown as { __flybyShout?: (s: string) => void }).__flybyShout;
    shout?.(`SHADER FAILED: ${String((vs as { name?: string }).name ?? "")} / ${String((fs as { name?: string }).name ?? "")}`);
    // Installing this handler REPLACES three.js's own report, which is the only
    // thing that ever names the offending line. Without the two logs below, a
    // one-word GLSL mistake shows up as nothing but a stream of
    // "useProgram: program not valid" from every subsequent draw.
    console.error("[flyby] vertex shader log:", gl.getShaderInfoLog(vs as WebGLShader));
    console.error("[flyby] fragment shader log:", gl.getShaderInfoLog(fs as WebGLShader));
  };
  const composite = new Composite(renderer);
  const target = createSceneTarget(renderer, budget);
  // Screen-space sky occlusion. Runs before the main pass, because the surface
  // shaders read its result rather than the composite doing so; see render/ao.ts.
  const ao = new AoPass(renderer);
  const quality = new AdaptiveQuality(renderer);

  const resizeTargets = () => {
    const s2 = renderer.getDrawingBufferSize(new THREE.Vector2());
    target.setSize(s2.x, s2.y);
    composite.resize(renderer);
    ao.resize(renderer);
  };
  addEventListener("resize", resizeTargets);

  // --- Screenshot mode ----------------------------------------------------
  // `?shot` says a machine is looking, not a person: no overlay, no adaptive
  // resolution, no animation clock. Everything that would differ between two
  // runs of the same URL is nailed down here in one place.
  const shotMode = new URLSearchParams(location.search).has("shot");
  const shotCam = pinnedCam();
  const pinScale = Number(new URLSearchParams(location.search).get("scale"));
  if (Number.isFinite(pinScale) && pinScale > 0) {
    quality.pin(pinScale);
    quality.apply(renderer);
    renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
    resizeTargets();
  }
  if (shotMode) ui.style.display = "none";

  const sky = new Sky();
  scene.add(sky.mesh);

  // Sun shadows. Constructed before anything that reads them, because the
  // cascade uniforms are spread by reference into the terrain and building
  // materials at the moment those materials are created.
  const sunShadow = new SunShadow(budget);
  // One environment probe for the whole scene: sky irradiance for every diffuse
  // surface and a prefiltered cube for the glass and the wet tarmac.
  const skyProbe = new SkyProbe();
  if (new URLSearchParams(location.search).get("shadows") === "0") sunShadow.enabled = false;
  // Whether this device gets ambient occlusion at all is render/budget.ts's
  // call; the query parameters below still override it either way, because
  // forcing it on is how the phone case gets tested from a desktop.
  const params = new URLSearchParams(location.search);
  ao.enabled = budget.aoEnabled;
  if (params.get("ao") === "0") ao.enabled = false;
  if (params.get("ao") === "1") ao.enabled = true;

  const terrain = new Terrain(origin, fields, drapes, sunShadow.uniforms);
  scene.add(terrain.group);

  // Buildings. A city with no baked pack still flies, it just has no skyline,
  // so this must never be able to fail the load.
  loading.set(0.92, "loading buildings");
  // Alongside the buildings, not after them: both are single files off the same
  // origin, so overlapping the two fetches costs nothing and saves a round trip.
  const landPromise = loadLandPack(city.id);
  const roadPromise = loadRoadPack(city.id);
  // The surveyed furniture, if anybody has surveyed this place. Fetched
  // alongside the roads rather than after them: it is a few tens of kilobytes
  // and waiting on it would put it on the load's critical path for nothing.
  const streetPromise = loadStreetPack(city.id);
  // Where a .city pack already covers the ground, so the live path never asks
  // Overpass for a square somebody has already baked. Same origin, one small
  // JSON, already in the cache from the start screen.
  const bakedPromise = bakedCityCoverage();
  const pack = await loadCityPack(city.id);
  let buildings: Buildings | null = null;
  // The rooftops as a height field, so the aeroplane has a floor over a city
  // rather than only over the ground under it.
  const skyline = new Skyline(pack, terrain.heightAt);
  // `?nobuildings` leaves the ground bare. It exists for the terrainDebug
  // views: those replace the TERRAIN's output only, so with a city standing on
  // it any measurement of a debug view is a mix of the isolated term and
  // ordinary shaded facades -- which is how a transmittance of 1.0 came out
  // reading 0.59 and sent an afternoon after an atmosphere bug that was not
  // there.
  const buildingsOff = new URLSearchParams(location.search).has("nobuildings");
  if (pack && !buildingsOff) {
    buildings = new Buildings(pack, terrain.heightAt, sunShadow.uniforms, budget);
    scene.add(buildings.group);
    console.log(
      `[flyby] buildings: ${buildings.stats.drawn} drawn, ` +
      `${buildings.stats.skippedFar} culled as small+distant, ` +
      `${buildings.stats.skippedFlat} flat slabs dropped, ` +
      `${buildings.stats.triangles} triangles in ${buildings.stats.cells} cells`,
    );
  } else {
    console.warn(`[flyby] no building pack for ${city.id}; run: bun tools/bake-city.ts --city ${city.id}`);
  }

  // Buildings the DRONE cannot fly through. Built once; a city with no pack
  // simply has no collision, the same way it has no skyline.
  let collision: CityCollision | null = null;
  if (pack) {
    const t0 = performance.now();
    collision = new CityCollision(pack, terrain.heightAt);
    console.log(
      `[flyby] collision: ${collision.stats.buildings} footprints in ` +
      `${collision.stats.cells} cells (max ${collision.stats.maxPerCell} per cell), ` +
      `${(collision.stats.bytes / 1048576).toFixed(1)} MB, ` +
      `${(performance.now() - t0).toFixed(0)} ms`,
    );
  }

  // Vector roads. Same contract as the skyline: a city with no .roads pack
  // still flies, its streets are just whatever the satellite drape shows.
  const roadPack = await roadPromise;
  let roads: Roads | null = null;
  if (roadPack) {
    roads = new Roads(roadPack, terrain.heightAt, sunShadow.uniforms, budget);
    scene.add(roads.group);
    const rs = roads.stats;
    console.log(
      `[flyby] roads: ${rs.drawn} drawn of ${roadPack.roads.length} ` +
      `(${rs.skippedFar} out of class range, ${rs.skippedTunnel} tunnels, ${rs.skippedShort} stubs), ` +
      `${rs.bridges} bridges, ${rs.triangles} triangles in ${rs.meshes} meshes, ` +
      `lod ${rs.lod}, ${rs.buildMs.toFixed(0)} ms`,
    );
  } else {
    console.warn(`[flyby] no road pack for ${city.id}; run: bun tools/bake-roads.ts --city ${city.id}`);
  }

  // The driveable network, for the car. Derived from the same pack the ribbons
  // are drawn from, so what you can drive on is what you can see. A city with
  // no .roads pack simply has no car, the same way it has no skyline.
  const car = roadPack ? new Car(buildRoadGraph(roadPack.roads)) : null;
  if (car) {
    const cs = car.stats;
    console.log(
      `[flyby] driveable graph: ${cs.edges} edges, ${cs.nodes} nodes, ` +
      `${cs.junctions} junctions, ${cs.indexedSegments} segments indexed, ${cs.buildMs} ms`,
    );
  }

  // The detail ring follows whatever is on the ground. It starts where the
  // terrain built it, so nothing changes until something asks it to move.
  const detailRing = new DetailRing(origin, terrain, budget.rings[0]);

  // The canopy. Declared here so setAo below can reach it; it cannot be BUILT
  // until the landcover pack has arrived, which happens after the road pack.
  let foliage: Foliage | null = null;

  // The street: lamps, moving traffic and parked cars. Declared here for the
  // same reason the canopy is -- setAo below has to reach them -- and built
  // after the road pack, beside the pavements they share a carriageway index
  // with.
  let lamps: StreetLamps | null = null;
  let traffic: Traffic | null = null;
  let parkedCars: ParkedCars | null = null;

  // Every building and road material whose uniforms the frame loop must keep
  // current. One entry each for the baked packs, and one more per streamed
  // tile. Arrays rather than a rebuilt list, because this is walked every frame
  // and allocating a new one per frame to hold two objects is pure garbage.
  const buildingUniformSets: BuildingUniforms[] = buildings ? [buildings.uniforms] : [];
  const roadUniformSets: RoadUniforms[] = roads ? [roads.uniforms] : [];
  // The street objects. TrafficUniforms is a superset of StreetLampUniforms, so
  // one array holds all three fields and the frame loop writes the shared half
  // once; the one uniform only the cars have, the animation clock, is set
  // beside it.
  const streetUniformSets: StreetLampUniforms[] = [];

  /**
   * Point every surface material at this frame's occlusion buffer.
   *
   * Zero is not "no occlusion pass", it is "this draw is not the main frame":
   * the buffer is indexed by gl_FragCoord, so it only means anything while the
   * main camera is the one drawing.
   */
  const setAo = (strength: number): void => {
    for (const u of terrain.uniforms) ao.apply(u, strength);
    for (const u of buildingUniformSets) ao.apply(u, strength);
    for (const u of roadUniformSets) ao.apply(u, strength);
    if (foliage) ao.apply(foliage.uniforms, strength);
    if (lamps) ao.apply(lamps.uniforms, strength);
    if (traffic) ao.apply(traffic.uniforms, strength);
    if (parkedCars) ao.apply(parkedCars.uniforms, strength);
  };

  // Where the city actually is, for night lighting. A place with no pack gets
  // an all-dark mask: unlit open country is a more honest answer than guessing
  // from the daylight imagery and lighting up the whole map.
  const urban: UrbanMask = pack ? buildUrbanMask(pack) : emptyUrbanMask();

  // Measured landcover: what is water, what is built, what is green. It is
  // awaited AFTER the terrain exists and can never fail the load, because a
  // city without a .land pack is not broken, it just falls back to the
  // sea-level water heuristic and to footprints alone for night lighting.
  const landPack = await landPromise;
  const land: LandMask = landPack ? buildLandMask(landPack) : emptyLandMask();
  if (!landPack) {
    console.warn(`[flyby] no landcover for ${city.id}; run: bun tools/bake-land.ts --city ${city.id}`);
  }

  // Term isolation for the terrain shader; see the ladder at the bottom of
  // render/terrain.ts. 9 and 10 are the landcover water and built channels,
  // 11 the four-channel false-colour.
  const terrainDebug = Number(new URLSearchParams(location.search).get("terrainDebug") ?? 0);

  for (const u of terrain.uniforms) {
    u.uUrban.value = urban.texture;
    u.uUrbanExtent.value = urban.extent;
    u.uLandNear.value = land.near;
    u.uLandFar.value = land.far;
    u.uLandNearExtent.value = land.nearExtent;
    u.uLandFarExtent.value = land.farExtent;
    u.uHasLand.value = land.has ? 1 : 0;
    if (Number.isFinite(terrainDebug)) u.uDebug.value = terrainDebug;
  }

  // What the canopy must not stand on. Both start from whatever packs loaded
  // and GROW as live tiles arrive, which is why they are built here rather than
  // inside the branch that happens to plant the first trees: a place with a
  // .land pack and no .city pack gets its roofs from the streamed buildings.
  const treeFootprints = new FootprintMask(
    pack ? pack.buildings : [],
    pack ? pack.radiusM : LIVE_EXTENT_M,
  );
  const treeRoads = new CompositeRoadIndex();
  if (roadPack) treeRoads.add(new RoadIndex(roadPack.roads, treeRoadClearanceM));

  let pavement: Pavement | null = null;

  // What counts as tarmac, for everything that has to stay off it: the pavement
  // opens at junctions, and a lamp column or a parked car must not stand in the
  // middle of one. One index, because Manhattan's is 400k segments and a second
  // copy of it is five megabytes and a hundred milliseconds for the same
  // answer.
  const packRoads = roadPack?.roads ?? [];
  const carriagewayIds: number[] = [];
  for (let i = 0; i < packRoads.length; i++) {
    if (isCarriageway(packRoads[i])) carriagewayIds.push(i);
  }
  const carriageways = new RoadIndex(
    carriagewayIds.map((i) => packRoads[i]),
    (r) => roadWidthM(r.cls, r.lanes, r.flags) * 0.5,
    32,
    // Positions in the PACK, not in the filtered copy: blockedExcept is asked
    // "is this point on a carriageway other than mine" with a pack index.
    (_r, i) => carriagewayIds[i],
  );

  // Pavements. Built here rather than beside the road ribbons because they need
  // the footprint mask above to know where the building line is, and that mask
  // needs the .city pack. A city with roads and no buildings still gets kerbs,
  // just at the class widths with a verge behind them.
  if (roadPack) {
    pavement = new Pavement(
      roadPack,
      terrain.heightAt,
      pack ? treeFootprints : null,
      sunShadow.uniforms,
      budget,
      carriageways,
    );
    scene.add(pavement.group);
    roadUniformSets.push(pavement.uniforms);
    // No eager build here. The frame loop calls update() before the first
    // render, so the ring is up on frame one, and building it at the ORIGIN
    // first would throw away every tile of it the moment the camera turned out
    // to be somewhere else -- which it is on every pinned pose.
    console.log(
      `[flyby] pavements: ${pavement.stats.indexedTiles} tiles of kerbable carriageway indexed`,
    );
  }

  // --- the street, from a car rather than from an aeroplane ----------------
  //
  // Lamps, moving traffic and parked cars, all placed from the SAME .roads
  // centrelines the ribbons are drawn from and the pavements are kerbed from.
  // Three fields rather than one because they are drawn to three different
  // distances: a moving car reads at a kilometre and a parked one does not read
  // at all past a few hundred metres. See render/traffic.ts.
  const streetPack = await streetPromise;
  // Off with `?nostreet`, which is how a before-and-after of the street is
  // taken on one build: the same reason `?nolive` exists. Nothing else in the
  // frame changes, so the difference between the two captures is exactly the
  // lamps, the traffic and the parked cars.
  const streetOff = new URLSearchParams(location.search).has("nostreet");
  if (roadPack && !streetOff) {
    // Where a surveyor has actually been. Only the lamps are used, and only to
    // move a procedurally placed column onto a real one within LAMP_SNAP_M; see
    // data/streetfurniture.ts for why it cannot do more than that.
    const surveyedLamps = (streetPack?.items ?? []).filter(
      (f) => f.kind === FurnitureKind.StreetLamp,
    );
    const lampIndex = surveyedLamps.length
      ? new PointIndex(surveyedLamps, LAMP_SNAP_M)
      : null;

    const streetWorld: StreetWorld = {
      groundY: terrain.heightAt,
      occupied: pack ? (x, z) => treeFootprints.occupied(x, z) : null,
      onCarriageway: (x, z, except) => carriageways.blockedExcept(x, z, except),
      nearestMeasuredLamp: lampIndex
        ? (x, z, maxM) => lampIndex.nearest(x, z, maxM)
        : null,
    };

    lamps = new StreetLamps(roadPack, streetWorld, sunShadow.uniforms, budget);
    scene.add(lamps.group);
    traffic = new Traffic(roadPack, streetWorld, sunShadow.uniforms, budget);
    scene.add(traffic.group);
    parkedCars = new ParkedCars(roadPack, streetWorld, sunShadow.uniforms, budget);
    scene.add(parkedCars.group);
    streetUniformSets.push(lamps.uniforms, traffic.uniforms, parkedCars.uniforms);
    console.log(
      `[flyby] street: ${lamps.stats.indexedTiles} tiles of lit carriageway, ` +
      `${surveyedLamps.length} surveyed lamp nodes` +
      `${streetPack ? "" : " (no .street pack: every lamp is placed procedurally)"}, ` +
      `${streetPack?.items.length ?? 0} furniture nodes in the pack`,
    );
  }

  // Trees, from the tree channel of the same pack the terrain shades from.
  //
  // Everything it needs is already here and none of it is a new download: the
  // coverage grid says how many and where, the .roads centrelines keep them off
  // the carriageway, and the .city rings keep them off the roofs. A city with
  // no road or building pack still gets trees, just with the landcover's built
  // class as the only guard.
  if (landPack) {
    const t0 = performance.now();
    const level = landPack.levels[0];
    foliage = new Foliage(
      {
        mask: { rgba: buildLandMaskRGBA(level), n: level.n, extentM: level.extentM },
        heightAt: terrain.heightAt,
        roads: treeRoads,
        footprints: treeFootprints,
      },
      sunShadow.uniforms,
      budget.tier === "reduced",
    );
    const indexMs = performance.now() - t0;
    foliage.update(0, 0);
    scene.add(foliage.group);
    const fs = foliage.stats;
    console.log(
      `[flyby] trees: ${fs.count} instances in ${fs.tiles} tiles ` +
      `(lod ${fs.lodCounts.join("/")} of ${TREE_LOD_TRIANGLES.join("/")} tris), ` +
      `${(fs.triangles / 1000).toFixed(0)}k triangles, ` +
      `${roadPack ? "roads excluded" : "no road pack"}, ` +
      `${pack ? "footprints excluded" : "no building pack"}, ` +
      `${indexMs.toFixed(0)} ms index + ${fs.rebuildMs.toFixed(0)} ms place` +
      `${fs.clipped ? " (CLIPPED to the instance budget)" : ""}`,
    );
  }

  // --- Live OSM, for the ground nobody baked --------------------------------
  //
  // Terrain, imagery, weather and landmarks have always worked anywhere on
  // Earth. Buildings, roads and trees only existed where somebody had run the
  // bakers, which is seven cities. Where there is no .city pack the app now
  // streams OSM around the camera instead, through exactly the converters the
  // bakers use. Off with `?nolive`, which is also how a baked city is compared
  // against a live one over the same ground.
  //
  // Deliberately NOT awaited: nothing below waits for a tile, and the flight
  // starts on terrain alone exactly as it does today.
  const liveOff = new URLSearchParams(location.search).has("nolive");
  let live: LiveWorld | null = null;
  if (!pack && !liveOff) {
    // A .land pack is measured 10 m raster and OSM landuse is a drawn boundary,
    // so where one exists it stays the canopy source and the live path only
    // contributes buildings and roads. Where there is none, OSM is the only
    // canopy a browser can reach at all: WorldCover's COGs send no CORS header.
    const liveVeg = landPack ? null : new LiveVegetation(LIVE_EXTENT_M);
    if (liveVeg && !foliage) {
      foliage = new Foliage(
        {
          mask: { rgba: liveVeg.rgba, n: liveVeg.n, extentM: liveVeg.extentM },
          heightAt: terrain.heightAt,
          roads: treeRoads,
          footprints: treeFootprints,
        },
        sunShadow.uniforms,
        budget.tier === "reduced",
      );
      foliage.update(0, 0);
      scene.add(foliage.group);
    }
    const endpoint = new URLSearchParams(location.search).get("overpass");
    live = new LiveWorld({
      origin,
      scene,
      heightAt: terrain.heightAt,
      shadow: sunShadow.uniforms,
      budget,
      packs: await bakedPromise,
      vegetation: liveVeg,
      footprints: treeFootprints,
      roadBlockers: treeRoads,
      buildingUniforms: buildingUniformSets,
      roadUniforms: roadUniformSets,
      onVegetation: () => foliage?.invalidate(),
      // `?overpass=` is a dev knob, and the only way the screenshot harness can
      // capture this without asking a volunteer server the same question on
      // every run.
      overpass: new Overpass(endpoint ? [endpoint] : undefined),
    });
    console.log(
      `[flyby] live OSM enabled for ${city.name}: no .city pack, streaming from Overpass`,
    );
  }

  const observed: Weather = await wxPromise;
  const timeline = await forecastPromise;
  const timezone = timeline?.timezone ?? "UTC";
  const wallClock = new LocalClock(timezone);
  const pinned = wxOverride(observed);
  let wx: Weather = pinned ?? observed;

  const hud = new Hud(ui);
  hud.setWeather(wx, 0);

  /**
   * What the panel says about where the city came from.
   *
   * A baked pack and a live stream are not the same fidelity and the HUD must
   * not imply they are: the baked one was converted from a whole-city Overpass
   * fetch offline and gated by the verifiers, the live one is whatever tiles
   * have arrived in the last minute with no measured landcover behind them.
   */
  const dataSource = (): DataSource => {
    if (pack) return { kind: "baked" };
    if (!live) return { kind: "none" };
    return {
      kind: "live",
      tiles: live.stats.tiles,
      fetching: live.stats.fetching,
      failed: live.stats.failed,
    };
  };
  hud.setPlace(city, wallClock.parts(now).time, wallClock.abbrev(now), dataSource());

  // Start the aircraft upwind of the centre, pointed at the city, at the
  // altitude this place looks best from.
  const groundAtCentre = terrain.heightAt(0, 0);
  const startHdg = city.approach;
  const back = 5200;
  const rad = (startHdg * Math.PI) / 180;
  const easy = new URLSearchParams(location.search).has("easy");
  const ac = new Aircraft(easy ? EASY_CONFIG : DEFAULT_CONFIG);
  const startX = -Math.sin(rad) * back;
  const startZ = Math.cos(rad) * back;
  // Start above the ROOFS, not the ground. Now that the rooftops are a floor,
  // spawning under one would have the first frame shove the aeroplane upward
  // out of a building it appeared to be inside.
  const startGround = Math.max(
    terrain.heightAt(startX, startZ),
    skyline.topAt(startX, startZ),
  );
  ac.reset(
    startX,
    chooseStartAltitude(city.startAlt, Math.max(startGround, groundAtCentre), wx.low),
    startZ,
    startHdg,
  );

  // A flight started from coordinates has no name yet. Ask what is down there,
  // and write it onto the city the panel is already reading from -- the lookup
  // is allowed to be slow or to fail, and either way the flight has started.
  if (city.id === "here") {
    void reverseGeocode(city.lat, city.lon).then((p) => {
      if (!p) return;
      city.name = p.name;
      city.country = [p.region, p.country].filter(Boolean).join(", ");
      document.title = `FLYBY - ${placeLabel(p)}`;
    });
  }

  // Names on the beacons. The beam said "something is here" and nothing else,
  // which is the half of the question nobody was asking.
  const labels = new Labels(ui);
  const beacon = new Beacon();
  scene.add(beacon.group);

  const chase = new ChaseCam();
  const input = new Input(canvas, ui);

  // The drone. It shares the camera and nothing else: while it is flying the
  // aeroplane is frozen exactly where it was, still drawn, still lit, and you
  // can go and look at it.
  const drone = new Drone();
  let droneActive = false;
  let carActive = false;
  // Field of view, eased. An FPV camera is wide -- most of the reason a drone
  // shot looks like a drone shot is the lens, not the flying -- but a cut from
  // 62 to 78 degrees reads as the world lurching, so it is a move, not a cut.
  const PLANE_FOV = camera.fov;
  const DRONE_FOV = 78;
  // Wider than the aeroplane's and narrower than the drone's. A street is a
  // corridor and a narrow lens down one reads as a telephoto shot of a street
  // rather than as being in it; the drone's 78 is a lens choice for an FPV look
  // and puts too much barrel on a horizon that is now at eye level.
  const CAR_FOV = 70;
  /**
   * Height above the ground under which the detail ring follows the camera.
   *
   * At 40 m the 400 m ring is most of what is in front of the lens and the
   * zoom-16 ring past it is 3.6 m per pixel, which is a smear at that range.
   * Higher up the aircraft covers 400 m in nine seconds, so following would be
   * a restitch every few seconds for a drape that is no longer the limiting
   * detail: from 400 m the terrain mesh and the building LOD are.
   */
  const DETAIL_FOLLOW_AGL_M = 40;
  const PLANE_NEAR = camera.near;

  const model = new AircraftModel(budget);
  scene.add(model.group);

  const osd = new Osd(ui);

  // A heading-up moving map with a compass round it. Fed the footprints once;
  // after that it only needs where the aeroplane is and which way it points.
  const minimap = new Minimap(ui);
  // A city with no building pack still gets the compass and the landmarks.
  if (pack) minimap.setCity(pack);
  const layers = new Layers(ui);

  // Places you can fly to, and something that flies you there. A list you can
  // only read is a list of things you now have to find by hand at a hundred
  // knots over a city you have never seen from the air.
  const autopilot = new Autopilot();
  /**
   * Put the aircraft half a mile off a place, pointed at it.
   *
   * Clicking a landmark used to ENGAGE THE AUTOPILOT toward it, which is the
   * right thing if you want the flight and the wrong thing almost every time:
   * at a hundred knots a landmark four miles away is two and a half minutes of
   * watching the same city go past, and the reason to click it was to look at
   * it. So a click arrives; the autopilot is still there for anyone who wants
   * to be flown.
   *
   * APPROACHED FROM WHERE YOU ALREADY ARE. The new position is half a mile out
   * along the bearing from the target back to the aircraft, so the city stays
   * the way round it was and the move reads as closing the distance rather than
   * as being teleported to the far side. Height is the landmark's own top,
   * which frames a tower from its middle rather than looking down on it, with a
   * floor that keeps the aeroplane off the terrain and out of the buildings.
   */
  const HALF_MILE_M = 804.7;
  const arriveAt = (p: PlaceRow): void => {
    const dx = ac.position.x - p.x;
    const dz = ac.position.z - p.z;
    const len = Math.hypot(dx, dz);
    // Standing exactly on it has no bearing to back off along; come in from
    // the south, which is where a first look at anything in the northern
    // hemisphere wants the sun.
    const ux = len > 1 ? dx / len : 0;
    const uz = len > 1 ? dz / len : 1;
    const x = p.x + ux * HALF_MILE_M;
    const z = p.z + uz * HALF_MILE_M;
    const ground = terrain.heightAt(x, z);
    const y = Math.max(ground + 120, p.topY - 40);
    // Compass heading from the new position back to the target. atan2(east,
    // north) with north as -z, which is the same convention Aircraft.reset
    // undoes internally.
    const hdg = (Math.atan2(p.x - x, -(p.z - z)) * 180) / Math.PI;
    ac.reset(x, y, z, (hdg + 360) % 360);
    droneActive = false;
    carActive = false;
    input.setPointerLock(false);
    autopilot.disengage();
    places.setActive(p.name);
    places.setNote("");
    hud.toast(`${p.name} \u00b7 half a mile out`);
  };

  const places = new Places(
    ui,
    (p) => arriveAt(p),
    // Nothing in the list matched, so look for the name across all of
    // Wikipedia. Anything inside the loaded world becomes a target here;
    // anything beyond it is a different flight, and the app already knows how
    // to start one of those from a coordinate.
    (q) => {
      void searchNamedPlaces(q).then((hits) => {
        if (hits.length === 0) {
          places.setNote(`nothing called "${q}"`);
          return;
        }
        const hit = hits[0];
        const w = origin.toWorld(hit.lat, hit.lon);
        if (Math.hypot(w.x, w.z) < 30000) {
          const row = { name: hit.name, x: w.x, z: w.z, topY: terrain.heightAt(w.x, w.z) + 120 };
          nearby.push(row);
          sortByRange();
          arriveAt(row);
        } else {
          places.setNote(`${hit.name} is a separate flight - loading`);
          goToCoords(hit.lat, hit.lon);
        }
      });
    },
  );

  // One list, nearest first, and no route.
  //
  // There used to be a five-landmark tour in a fixed order with a panel
  // tracking your progress through it, which is a game about compliance rather
  // than a sightseeing flight: it decided where you were going next. The list
  // is now every named thing near you -- the city's curated landmarks and
  // whatever Wikipedia knows is down there -- and clicking one points the
  // aeroplane at it.
  const curated: PlaceRow[] = city.landmarks.map((l) => {
    const w = origin.toWorld(l.lat, l.lon);
    return { name: l.name, x: w.x, z: w.z, topY: terrain.heightAt(w.x, w.z) + (l.height ?? 40) + 60 };
  });
  let nearby: PlaceRow[] = [...curated];
  const sortedAt = { x: 0, z: 0 };
  const sortByRange = () => {
    sortedAt.x = ac.position.x;
    sortedAt.z = ac.position.z;
    nearby.sort(
      (a, b) =>
        Math.hypot(a.x - ac.position.x, a.z - ac.position.z) -
        Math.hypot(b.x - ac.position.x, b.z - ac.position.z),
    );
    places.setPlaces(nearby);
    minimap.setPlaces(nearby);
    places.setVisible(layers.landmarks);
  };
  sortByRange();

  // Fired after the flight has started: discovery must never be able to delay
  // it, and a failure is silent because the flight is the point.
  void fetchNearby(city.lat, city.lon).then((found) => {
    const seen = new Set(curated.map((c) => c.name));
    for (const f of found) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      const w = origin.toWorld(f.lat, f.lon);
      nearby.push({ name: f.name, x: w.x, z: w.z, topY: terrain.heightAt(w.x, w.z) + 120 });
    }
    sortByRange();
  });
  const timebar = new Timebar(ui, {
    lat: city.lat,
    lon: city.lon,
    base,
    timezone,
    timeline,
    onOffset: (secs) => {
      clockOffset = secs;
      wxDirty = true;
    },
    onTimelapse: (on) => {
      timelapse = on;
      input.timelapse = on;
    },
  });
  input.onTimelapse = (on) => {
    timelapse = on;
    timebar.setTimelapse(on);
  };
  if (!timeline) {
    hud.toast("No forecast feed — the clock moves the sun only");
  }

  loading.done();

  // Live tuning scale, driven from the console while looking at the scene.
  let exposureScale = 1;

  // Frame timing, smoothed. A raw per-frame number is unreadable.
  let smoothedMs = 16;
  // Starts past the threshold so the first frame fills the panels. Starting at
  // zero left the place name, the clock and the route blank for the first four
  // tenths of a second, which is exactly when someone is looking at them.
  // The frame counter is a developer's instrument, not a passenger's. It is
  // still one query string away, because the number it shows is the one that
  // says whether a change made the app better or worse.
  const showPerf = new URLSearchParams(location.search).has("fps");
  let perfAccum = 1;

  // The banding metric reads the cloud buffer back off the GPU, which stalls
  // the pipeline, so it runs on its own slow cadence rather than every perf
  // tick: sampled at 0.4 s it would be measuring its own cost in the ms it
  // sits next to.
  let banding = 0;
  let bandAccum = 0;
  const BAND_PERIOD = 2;

  // Weather is resampled on a timer, not per frame: `timeline.at` allocates a
  // Weather, and doing that 60 times a second to answer a question whose answer
  // changes on an hourly grid is pure garbage.
  let wxAccum = 0;
  let wxDirty = false;

  const clock = new THREE.Clock();
  let elapsed = 0;

  // The traffic model's half of the clock, pushed into the car shaders below.
  //
  // `classClock[c]` is seconds of TRAVEL that road class has done, which stops
  // tracking `elapsed` the moment the class is congested. Kept at double
  // precision because it is an accumulator that runs for the life of the
  // session, unlike the frac beside it, which is recomputed from scratch.
  let lastElapsed = 0;
  const classClock = new Float64Array(CLASS_COUNT);
  const classTraffic = new Float32Array(CLASS_COUNT * 2);
  // The offset the traffic curves are read at, resolved ONCE.
  //
  // Not `timeline?.utcOffsetSeconds ?? 0` at each call site: that makes the
  // hour of the day depend on whether a network fetch succeeded, and in
  // `?shot` it makes a fixed pose photograph a busy street or an empty one
  // depending on the weather feed. Shot mode therefore ignores the feed
  // entirely and takes the longitude, which is the same on every run; a live
  // session prefers the real offset and keeps the longitude as its floor.
  const trafficUtcOffset = shotMode
    ? utcOffsetFromLongitude(city.lon)
    : timeline?.utcOffsetSeconds ?? utcOffsetFromLongitude(city.lon);
  let trafficNow = trafficState(now, trafficUtcOffset, wx);

  // Frames drawn since the loop started, and their raw costs. The harness waits
  // on the count (a first frame still has shaders compiling and textures
  // uploading in it) and reads the ring for the frame-cost number.
  let shotFrames = 0;
  let timedFrames = 0;
  const frameRing = new Float64Array(600);

  renderer.setAnimationLoop(() => {
    // The RAW delta is what the frame-cost metric records; `dt` is the clamped
    // one the simulation integrates with. Keeping them separate is the whole
    // point: the clamp exists so one long stall cannot teleport the aeroplane
    // through a building, and feeding the clamped value to the metric made p99
    // report the CLAMP. It came back as exactly 50.00 ms for every pose in
    // every build, which is a tail metric that cannot distinguish anything.
    const rawDt = clock.getDelta();
    const dt = Math.min(0.05, rawDt);
    // The animation clock stays at zero for a screenshot. It drives the cloud
    // drift, the sky and the beacon, and a wall-clock-derived phase is the one
    // thing that would make two runs of the same URL differ.
    if (!shotMode) elapsed += dt;

    // --- Which machine is flying ------------------------------------------
    if (input.droneToggled > 0) {
      input.droneToggled = 0;
      droneActive = !droneActive;
      if (droneActive) {
        // Two machines cannot both have the camera. Stepping into the drone
        // from the car is a step out of the car.
        carActive = false;
        // Carries the aeroplane's momentum, so the swap is a step out of the
        // cockpit rather than a cut to a different shot.
        drone.enterFrom(ac.position, ac.headingDeg, ac.velocity);
        input.setPointerLock(true);
        hud.toast("Drone: WASD fly \u00b7 R/F up-down \u00b7 mouse looks \u00b7 Shift boost \u00b7 V back to the Cessna");
      } else {
        input.setPointerLock(false);
        hud.toast("Back in the Cessna");
      }
    }

    if (input.carToggled > 0) {
      input.carToggled = 0;
      if (carActive) {
        carActive = false;
        input.setPointerLock(false);
        hud.toast("Back in the Cessna");
      } else if (!car) {
        hud.toast("No road data here \u00b7 bake a .roads pack for this city");
      } else {
        // Enter from wherever the camera actually is, carrying whatever of the
        // machine's momentum the road can use. Same idea as the drone: a step
        // out of the aircraft, not a scene reload.
        const from = droneActive ? drone.position : ac.position;
        const hdg = droneActive ? drone.yawDeg : ac.headingDeg;
        const vel = droneActive ? drone.velocity : ac.velocity;
        if (car.enterFrom(from, hdg, vel, terrain.heightAt)) {
          carActive = true;
          droneActive = false;
          input.setPointerLock(true);
          hud.toast("Car: W/S drive \u00b7 A/D steer and pick the turning \u00b7 mouse looks \u00b7 G to get out");
        } else {
          hud.toast("No road within reach \u00b7 fly closer to a street");
        }
      }
    }

    const sampled = input.sample(dt);
    const axes = autopilot.update(
      sampled,
      ac.position,
      ac.headingDeg,
      ac.rollDeg,
      input.manualStick,
    );
    if (autopilot.justArrived) {
      hud.flashLandmark(autopilot.justArrived);
      places.setActive(null);
    }

    // --- Clock ------------------------------------------------------------
    // Every way of moving the clock funnels through `timebar.setOffset`, so the
    // slider, the keys and the timelapse cannot disagree about what time it is.
    const nudge = input.drainTimeNudge();
    if (nudge) timebar.setOffset(timebar.offsetSeconds + nudge);
    if (input.drainTimeReset()) timebar.setOffset(0);
    if (input.timelapse !== timelapse) {
      timelapse = input.timelapse;
      timebar.setTimelapse(timelapse);
    }
    if (timelapse) timebar.setOffset(timebar.offsetSeconds + dt * TIMELAPSE_RATE);
    now = sceneNow();

    // --- Weather for that clock -------------------------------------------
    wxAccum += dt;
    if (timeline && (wxDirty || wxAccum > 0.5)) {
      wxAccum = 0;
      wxDirty = false;
      // Inside a quarter of an hour of the present the OBSERVATION wins. It is
      // a measurement and the forecast for the same hour is not, and a model
      // that disagrees with the sky outside the window is the one thing that
      // would make the whole feed untrustworthy.
      const next = pinned ?? (Math.abs(clockOffset) < 900 ? observed : timeline.at(now));
      if (next !== wx) {
        wx = next;
        wxDirty = false;
      }
    }

    // The floor is the higher of the ground and whatever is built on it. The
    // aircraft adds its own clearance above whatever this returns, so a
    // rooftop is skimmed rather than landed on.
    const groundUnderAc = Math.max(
      terrain.heightAt(ac.position.x, ac.position.z),
      skyline.topAt(ac.position.x, ac.position.z),
    );
    ac.setWeather(wx, ac.position.y);
    // The aeroplane stops being integrated while the drone is up. Not paused
    // globally -- the sun still moves, the clouds still drift -- just parked.
    if (!input.paused && !droneActive && !carActive) ac.update(axes, dt, groundUnderAc);

    // The drone's floor is the TERRAIN, deliberately not the rooftops the
    // aeroplane uses. The whole point is to get down between the buildings,
    // and a roof-height floor over a city is a lid on the street.
    const groundUnderDrone = terrain.heightAt(drone.position.x, drone.position.z);
    if (droneActive) {
      // Drained every frame even while paused, or the mouse travel banks up
      // behind the pause and the view snaps when it lets go.
      const di = input.droneAxes(dt);
      if (!input.paused) {
        drone.update(di, dt, groundUnderDrone);
        // After the integrate and after the terrain clamp, so the push-out is
        // the last word on where the drone ended up this frame.
        //
        // The DRONE only. Flying the Cessna into a tower would end the flight,
        // which nobody asked for, and the aeroplane already has the rooftop
        // height field as a floor keeping it over the city rather than in it.
        collision?.resolve(drone.position, drone.velocity, DRONE_RADIUS);
      }
    }

    if (carActive && car) {
      // Drained every frame even while paused, for the same reason the drone's
      // is: banked-up mouse travel snaps the view when the pause lets go.
      const ci = input.carAxes();
      if (!input.paused) car.update(ci, dt, terrain.heightAt);
    }

    hud.setLayers(layers.weather);
    osd.root.style.display = layers.instruments ? "" : "none";

    labels.visible = layers.landmarks;
    places.setVisible(layers.landmarks);
    // Above the thing, not on it: a label at ground level is behind the
    // building it names as soon as you are lower than the roof.
    labels.update(
      camera,
      nearby.map((p) => ({
        name: p.name,
        x: p.x,
        y: p.topY,
        z: p.z,
        done: autopilot.target?.name === p.name,
      })),
      ac.position,
    );

    if (input.helpToggled > 0) {
      input.helpToggled = 0;
      hud.toggleControls();
    }

    chase.mode = CAMERA_MODES[input.cameraCycled % CAMERA_MODES.length];
    if (carActive && car) {
      // Straight off the car, like the drone: the camera IS the driver's head,
      // an eye height over the carriageway the car is standing on.
      car.eye(camera.position);
      camera.up.set(0, 1, 0);
      car.orientation(camera.quaternion);
    } else if (droneActive) {
      // Driven straight off the drone, with no rig, no lag and no look-at: the
      // camera IS the machine, and the lean it has is the lean it flew.
      camera.position.copy(drone.position);
      camera.up.set(0, 1, 0);
      drone.orientation(camera.quaternion);
    } else {
      chase.update(camera, ac, dt, input.lookBack, terrain.heightAt(camera.position.x, camera.position.z));
    }

    // A pinned lens overrides whichever rig just ran. Heading is a COMPASS
    // bearing and the Euler about +y runs the other way, the same sign trap
    // Aircraft.reset carries a note about.
    if (shotCam) {
      const w = origin.toWorld(shotCam.lat, shotCam.lon);
      camera.position.set(w.x, shotCam.altM, w.z);
      camera.quaternion.setFromEuler(
        new THREE.Euler(
          (shotCam.pitchDeg * Math.PI) / 180,
          (-shotCam.hdgDeg * Math.PI) / 180,
          0,
          "YXZ",
        ),
      );
      camera.up.set(0, 1, 0);
    }

    // Keep the sharp ground under anything that is nearly ON the ground.
    //
    // Driven off the CAMERA rather than off whichever machine is active, and
    // after the pinned shot camera has had its say, so it covers all three
    // cases with one rule: the car (always at eye height), the drone flying
    // down a street, and a fixed street-level pose in the screenshot harness.
    // The aeroplane and every aerial pose are above the threshold and are left
    // exactly as they were. Asked every frame and almost always a no-op; see
    // render/detailring.ts for when it is not.
    const camGround = terrain.heightAt(camera.position.x, camera.position.z);
    if (camera.position.y - camGround < DETAIL_FOLLOW_AGL_M) {
      const carDir = (car?.headingDeg ?? 0) * Math.PI / 180;
      const vx = carActive && car ? Math.sin(carDir) * car.speed : droneActive ? drone.velocity.x : 0;
      const vz = carActive && car ? -Math.cos(carDir) * car.speed : droneActive ? drone.velocity.z : 0;
      detailRing.follow(camera.position.x, camera.position.z, vx, vz);
    }

    // Ease the lens. ~0.4 s to settle, and the projection matrix is rebuilt
    // only while it is actually moving.
    const wantFov = carActive ? CAR_FOV : droneActive ? DRONE_FOV : PLANE_FOV;
    if (Math.abs(camera.fov - wantFov) > 0.01) {
      camera.fov += (wantFov - camera.fov) * (1 - Math.pow(0.0006, dt));
      if (Math.abs(camera.fov - wantFov) <= 0.01) camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
    // The near plane is the aeroplane's nose everywhere except in the car, where
    // it is the tarmac under the windscreen; see CAR_NEAR_PLANE_M. Stepped
    // rather than eased, because a moving near plane moves every depth in the
    // buffer and the shadow cascades are fitted against it.
    const wantNear = carActive ? CAR_NEAR_PLANE_M : PLANE_NEAR;
    if (camera.near !== wantNear) {
      camera.near = wantNear;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();

    model.group.position.copy(ac.position);
    model.group.quaternion.copy(ac.quaternion);
    // In the cockpit view the camera is INSIDE the aeroplane, so drawing it
    // fills the frame with the back of its own instrument panel.
    // Hidden in the seat, and hidden once the automatic descent into the seat
    // is nearly complete -- past that the camera is inside the cabin and the
    // airframe is a shell wrapped round the lens.
    // Always drawn while droning, whatever the chase rig had decided: flying
    // round your own parked Cessna is most of the fun of leaving it.
    // Hide the airframe BEFORE the camera gets inside it, not after.
    //
    // The rig lerps from the chase offset (0, 3.5, 10) to the seat
    // (0, 0.92, -0.15), and the tail sits at z = 4.25, so the camera crosses
    // into the fuselage at a blend of about 0.57. The old threshold of 0.9 left
    // a band where you were sitting inside the aeroplane with it still drawn:
    // what you saw was the double-sided propeller-blur disc filling the screen
    // as a grey dome, with the wings hanging in front of you.
    //
    // The shot camera never draws it at all: a fixed-pose screenshot is about
    // the city, and an aeroplane parked in the middle of it would be the most
    // prominent thing that changed between two otherwise identical frames.
    model.group.visible =
      !shotCam && (droneActive || carActive || (chase.mode !== "cockpit" && chase.cockpitBlend < 0.45));
    // Zeroed control surfaces while droning. W and A are the drone's now, and
    // a parked aeroplane waggling its ailerons at them looks haunted.
    const parked = droneActive || carActive;
    model.update(dt, ac.throttle, parked ? 0 : axes.roll, ac.pitchDeg, parked ? 0 : axes.yaw);

    // The beam stands on wherever you asked to go, and nowhere at all when you
    // have not asked. It used to mark the tour's next stop, which meant there
    // was always a beam and it was always somebody else's idea.
    const t = autopilot.target;
    beacon.update(
      t && layers.landmarks
        ? { x: t.x, z: t.z, groundY: terrain.heightAt(t.x, t.z) }
        : null,
      elapsed,
      t ? Math.hypot(t.x - ac.position.x, t.z - ac.position.z) : 0,
    );

    const solar = solarState(now, city.lat, city.lon);
    const light = computeLighting(solar, wx);

    const camAlt = camera.position.y;
    sky.update(solar, wx, camAlt, elapsed);
    sky.syncCamera(camera);

    for (const u of terrain.uniforms) {
      // By reference: one array, refreshed in place by the probe, so no ring
      // can be shading against a stale sky.
      u.uSH.value = skyProbe.sh;
      u.uCameraPos.value.copy(camera.position);
      u.uSunDir.value.copy(light.sunDir);
      u.uSunColor.value.copy(light.sunColor);
      u.uSunIntensity.value = light.sunIntensity;
      u.uAmbient.value.copy(light.ambient);
      u.uWetness.value = light.wetness;
      u.uSnow.value = light.snow;
      u.uNight.value = light.night;
      u.uNightGlow.value.copy(light.nightGlow);
      u.uMoonDir.value.copy(light.moonDir);
      u.uMoonLight.value.copy(light.moonLight);
      u.uMieG.value = light.mieG;
      u.uTurbidity.value = light.turbidity;
      u.uCamAltitude.value = camAlt;
      u.uExposure.value = light.exposure * exposureScale;
    }
    sky.uniforms.uExposure.value = light.exposure * exposureScale;

    // Local SOLAR hour, from UTC and the longitude, rather than the civil
    // hour: it needs no timezone database, it is what the sun is actually
    // doing, and the lights coming on want to track the evening rather than
    // a political line on a map.
    const localHour =
      (now.getUTCHours() + now.getUTCMinutes() / 60 + city.lon / 15 + 24) % 24;
    const hf = hourFactors(localHour);
    for (const b of buildingUniformSets) {
      b.uCameraPos.value.copy(camera.position);
      b.uSH.value = skyProbe.sh;
      b.uEnv.value = skyProbe.texture;
      b.uEnvMaxLod.value = skyProbe.maxLod;
      b.uSunDir.value.copy(light.sunDir);
      b.uSunColor.value.copy(light.sunColor);
      b.uSunIntensity.value = light.sunIntensity;
      b.uNight.value = light.night;
      b.uNightGlow.value.copy(light.nightGlow);
      b.uMoonDir.value.copy(light.moonDir);
      b.uMoonLight.value.copy(light.moonLight);
      b.uWetness.value = light.wetness;
      b.uMieG.value = light.mieG;
      b.uTurbidity.value = light.turbidity;
      b.uCamAltitude.value = camAlt;
      b.uExposure.value = light.exposure * exposureScale;
      b.uHourFactor.value.set(hf.residential, hf.office, hf.other);
    }

    for (const r of roadUniformSets) {
      r.uCameraPos.value.copy(camera.position);
      r.uSH.value = skyProbe.sh;
      r.uEnv.value = skyProbe.texture;
      r.uEnvMaxLod.value = skyProbe.maxLod;
      r.uSunDir.value.copy(light.sunDir);
      r.uSunColor.value.copy(light.sunColor);
      r.uSunIntensity.value = light.sunIntensity;
      r.uWetness.value = light.wetness;
      r.uSnow.value = light.snow;
      r.uNight.value = light.night;
      r.uNightGlow.value.copy(light.nightGlow);
      r.uMoonDir.value.copy(light.moonDir);
      r.uMoonLight.value.copy(light.moonLight);
      r.uMieG.value = light.mieG;
      r.uTurbidity.value = light.turbidity;
      r.uCamAltitude.value = camAlt;
    }

    // Ask for the ground ahead. Cheap every frame: it only rescans once the
    // camera has moved a few hundred metres, and the rate limiter decides when
    // anything is actually sent.
    live?.update(camera.position.x, camera.position.z);

    // Keep the kerbs under the camera. Cheap every frame: it only rebuilds when
    // the camera has crossed a 400 m tile boundary.
    pavement?.update(camera.position.x, camera.position.z);

    // The street fields follow the same 400 m tiles, and each of them holds a
    // ring of its own size around the camera; see render/traffic.ts for why the
    // moving cars reach four times further than the parked ones.
    lamps?.update(camera.position.x, camera.position.z);
    traffic?.update(camera.position.x, camera.position.z);
    parkedCars?.update(camera.position.x, camera.position.z);
    for (const u of streetUniformSets) {
      u.uCameraPos.value.copy(camera.position);
      u.uSH.value = skyProbe.sh;
      u.uSunDir.value.copy(light.sunDir);
      u.uSunColor.value.copy(light.sunColor);
      u.uSunIntensity.value = light.sunIntensity;
      u.uNight.value = light.night;
      u.uNightGlow.value.copy(light.nightGlow);
      u.uMoonDir.value.copy(light.moonDir);
      u.uMoonLight.value.copy(light.moonLight);
      u.uMieG.value = light.mieG;
      u.uTurbidity.value = light.turbidity;
      u.uCamAltitude.value = camAlt;
    }
    // THE HOUR OF THE DAY, on the traffic. Two numbers per road class: how much
    // of the placed peak density is out, and a clock that has been integrated
    // at that class's own congested speed.
    //
    // Integrated against the DELTA OF `elapsed`, which is what keeps `?shot`
    // reproducible: in shot mode `elapsed` never moves, so `dEl` is zero for
    // ever and every class clock stays at zero however long the page is open.
    // Integrating wall clock here, or reading the scene clock directly, would
    // put the cars somewhere different on every run of the same pinned URL.
    //
    // And it is an integral rather than a multiplier because the shader is at
    // fract(phase + clock * rate): scaling the rate would move every car the
    // instant the hour changed, which under a dragged scrubber or a 600x
    // timelapse is the whole city jumping. Changing only the derivative leaves
    // every car exactly where it was.
    const dEl = elapsed - lastElapsed;
    lastElapsed = elapsed;
    // `now` and not a fresh sceneNow(): the same instant the sun was placed at
    // this frame, so a scrubbed 08:00 has both the light and the rush hour of
    // 08:00. It also saves a Date allocation on every frame.
    const ts = trafficState(now, trafficUtcOffset, wx);
    trafficNow = ts;
    for (let c = 0; c < CLASS_COUNT; c++) {
      classClock[c] += dEl * ts.speed[c];
      classTraffic[c * 2] = ts.frac[c];
      classTraffic[c * 2 + 1] = classClock[c];
    }
    for (const u of [traffic, parkedCars]) {
      if (!u) continue;
      // The animation clock, and nothing else: the car shader takes its sky
      // reflection from the SH probe rather than from the prefiltered cube, so
      // unlike the roads it has no environment map to point at. The animation
      // clock is what `?shot` holds at zero, so traffic that moved on wall-clock
      // phase would make two runs of the same pinned URL differ.
      u.uniforms.uTime.value = elapsed;
      u.uniforms.uClassTraffic.value.set(classTraffic);
    }

    if (foliage) {
      // Rebuilt only when the camera has moved far enough for a tree's level of
      // detail to be stale; see render/trees.ts.
      foliage.update(camera.position.x, camera.position.z);
      foliage.setWind(wx.windSpeed, wx.windDir);
      const f = foliage.uniforms;
      // The animation clock, which `?shot` holds at zero: a canopy that swayed
      // on wall-clock phase would make two runs of the same URL differ.
      f.uTime.value = elapsed;
      f.uCameraPos.value.copy(camera.position);
      f.uSH.value = skyProbe.sh;
      f.uSunDir.value.copy(light.sunDir);
      f.uSunColor.value.copy(light.sunColor);
      f.uSunIntensity.value = light.sunIntensity;
      f.uNight.value = light.night;
      f.uNightGlow.value.copy(light.nightGlow);
      f.uMoonDir.value.copy(light.moonDir);
      f.uMoonLight.value.copy(light.moonLight);
      f.uMieG.value = light.mieG;
      f.uTurbidity.value = light.turbidity;
      f.uCamAltitude.value = camAlt;
    }

    const p = model.uniforms;
    p.uSunDir.value.copy(light.sunDir);
    p.uSunColor.value.copy(light.sunColor);
    p.uSunIntensity.value = light.sunIntensity;
    p.uMoonDir.value.copy(light.moonDir);
    p.uMoonLight.value.copy(light.moonLight);
    p.uSH.value = skyProbe.sh;
    p.uCameraPos.value.copy(camera.position);

    // The extra passes, in order: the sun's cascaded shadow maps over the whole
    // city, then the aircraft's environment probe (so the airframe reflects the
    // real sky and ground it is flying through) and its self-shadow map (so the
    // high wing lies across the cabin the way it does in every photograph of
    // one). All of them render the scene with a camera that is not the main
    // one, and the sky is a full-screen triangle driven by camera UNIFORMS
    // rather than by the camera it is handed -- so its matrices have to be put
    // back before the main pass. The shadow cascades exclude the sky by layer;
    // the probe cannot, which is what the onFace callback is for.
    // The sky probe, before anything that reads it. It re-renders on its own
    // cadence rather than every frame; see render/skyprobe.ts.
    skyProbe.setSize(quality.scale < 0.8 ? 32 : 64);
    skyProbe.update(renderer, light, camAlt);
    // The canopy is instanced, so it cannot be drawn through the depth-only
    // override the cascades and the AO prepass use; it comes in as its own
    // scene carrying its own depth shader. See render/trees.ts.
    // Instanced fields cannot be drawn through the depth-only override the
    // cascades and the AO prepass use, because that override would replace
    // their vertex shaders and stack every instance on the origin. Each brings
    // its own depth scene carrying its own depth shader; see render/trees.ts.
    //
    // The cars are in the SUN cascades and not in the ambient-occlusion
    // prepass, and the split is measured rather than tidy: the two extra depth
    // scenes cost 1.0 ms of a 9.9 ms frame on `sf-street`, and the cost is the
    // vertex fetch over a million triangles four times rather than anything the
    // fade could cull. A car's contact shadow is most of what stops it looking
    // pasted onto the road, so the cascades keep it; screen-space occlusion
    // around a 4.6 m box that already has a hard shadow under it is the quarter
    // of that cost with the least to show for it.
    const shadowCasters = [
      ...(foliage ? [foliage.depthScene] : []),
      ...(traffic ? [traffic.depthScene] : []),
      ...(parkedCars ? [parkedCars.depthScene] : []),
    ];
    // The AO prepass needs the SAME list. Anything whose vertex shader places
    // it, and which is therefore absent from this buffer, does not merely fail
    // to occlude its neighbours: its own fragments read the sky occlusion of
    // whatever is BEHIND it. A car in a street canyon then shades against the
    // pavement under the far kerb and comes out black, which is exactly what it
    // did until this line stopped being a shorter list than the one above it.
    sunShadow.update(renderer, scene, camera, light.sunDir, quality.scale, shadowCasters);
    // The environment probe renders the city into a cube with its own camera
    // and its own viewport, where a gl_FragCoord lookup into a buffer built for
    // the main frame would be reading the wrong pixel of the wrong picture.
    // Off for that pass, back on for this one.
    setAo(0);
    model.prepare(renderer, scene, quality.scale, (c) => sky.syncCamera(c));
    sky.syncCamera(camera);
    ao.render(renderer, scene, camera, shadowCasters);
    setAo(1);

    // Drift angle: the difference between where the nose points and where the
    // machine is actually going over the ground.
    const track = (Math.atan2(ac.velocity.x, -ac.velocity.z) * 180) / Math.PI;
    let drift = track - ac.headingDeg;
    while (drift > 180) drift -= 360;
    while (drift < -180) drift += 360;

    // Climb angle of the actual path over the ground, for the flight path
    // marker. Derived from the velocity rather than from the attitude, which is
    // the whole point of the marker: in a headwind the two disagree.
    const gs = ac.groundSpeed;
    const fpa = (Math.atan2(ac.verticalSpeed, Math.max(gs, 1)) * 180) / Math.PI;

    // The map follows whatever you are actually flying. In the drone the
    // aeroplane is parked somewhere behind you, and a moving map centred on it
    // would be pointing at a landmark you left two blocks ago.
    if (carActive && car) {
      minimap.update(car.position.x, car.position.z, car.headingDeg, elapsed);
    } else if (droneActive) {
      minimap.update(drone.position.x, drone.position.z, drone.yawDeg, elapsed);
    } else {
      minimap.update(ac.position.x, ac.position.z, ac.headingDeg, elapsed);
    }

    osd.setDrone(
      carActive && car
        ? { speedMs: Math.abs(car.speed), aglM: 0 }
        : droneActive
        ? { speedMs: drone.speed, aglM: drone.position.y - groundUnderDrone }
        : null,
    );
    if (!droneActive && !carActive) {
      osd.update({
        pitchDeg: ac.pitchDeg,
        rollDeg: ac.rollDeg,
        headingDeg: ac.headingDeg,
        altM: ac.position.y,
        aglM: ac.position.y - groundUnderAc,
        groundSpeed: ac.groundSpeed,
        airspeed: ac.airspeed,
        verticalSpeed: ac.verticalSpeed,
        rollRateDps: ac.rollRateDps,
        pitchRateDps: ac.pitchRateDps,
        yawRateDps: ac.yawRateDps,
        flightPathDeg: fpa,
        gLoad: ac.loadFactor,
        driftDeg: drift,
        windDirDeg: wx.windDir,
        windSpeed: Math.hypot(ac.windVector.x, ac.windVector.z),
        boost: axes.boost > 0.5,
      });
    }

    // Pass 1: the world, in linear HDR, into the offscreen target.
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);

    // Pass 2 + 3: clouds raymarched at half resolution against that target's
    // depth, then a full-resolution present that folds them in and tone maps.
    composite.update(camera, wx, light, elapsed);
    composite.uniforms.uSunSurfaceCloud.value = 0.105;
    composite.presentUniforms.uExposure.value = light.exposure * exposureScale;
    composite.presentUniforms.uNight.value = light.night;
    composite.brightUniforms.uExposure.value = light.exposure * exposureScale;
    composite.brightUniforms.uNight.value = light.night;
    composite.render(renderer, target.texture, target.depthTexture);

    if (timedFrames < frameRing.length) frameRing[timedFrames++] = rawDt * 1000;
    shotFrames++;

    smoothedMs += (dt * 1000 - smoothedMs) * 0.06;
    if (quality.update(smoothedMs, dt)) {
      quality.apply(renderer);
      const w = canvas.clientWidth || innerWidth;
      const h = canvas.clientHeight || innerHeight;
      renderer.setSize(w, h, false);
      resizeTargets();
      console.log(`[flyby] render scale -> ${quality.scale.toFixed(2)} (${smoothedMs.toFixed(1)} ms)`);
    }
    if (showPerf) {
      bandAccum += dt;
      if (bandAccum > BAND_PERIOD) {
        bandAccum = 0;
        banding = composite.measureBanding(renderer).ratio;
      }
    }

    perfAccum += dt;
    if (perfAccum > 0.4) {
      perfAccum = 0;
      if (showPerf) {
        hud.setPerf(
          1000 / smoothedMs,
          smoothedMs,
          buildings ? buildings.stats.triangles : 0,
          quality.scale,
          banding,
        );
      }
      hud.setWeather(wx, clockOffset);
      hud.setPlace(city, wallClock.parts(now).time, wallClock.abbrev(now), dataSource());
      places.update(ac.position.x, ac.position.z);
      // Re-sorted only after a kilometre of travel. Sorting every tick would
      // reorder the rows under the cursor while you were reaching for one.
      if (Math.hypot(ac.position.x - sortedAt.x, ac.position.z - sortedAt.z) > 1000) {
        sortByRange();
      }
      timebar.update(now, solar.sun.altitude);
    }
  });

  // Handy for poking at the scene from the console during development.
  const tune = (name: string, value: number) => {
    const sets: Record<string, THREE.IUniform>[] = [
      sky.uniforms as unknown as Record<string, THREE.IUniform>,
      composite.uniforms as Record<string, THREE.IUniform>,
      ...(terrain.uniforms as unknown as Record<string, THREE.IUniform>[]),
      ...(buildings ? [buildings.uniforms as Record<string, THREE.IUniform>] : []),
      ...(roads ? [roads.uniforms as Record<string, THREE.IUniform>] : []),
    ];
    let hit = 0;
    for (const set of sets) if (name in set) { set[name].value = value; hit++; }
    return `${name} = ${value} (${hit} materials)`;
  };

  // The screenshot harness's whole interface to the page. Deliberately tiny:
  // "have you drawn enough frames to be worth looking at", "give me the pixels"
  // and "what did the last N frames cost".
  Object.assign(window as unknown as Record<string, unknown>, {
    flybyShot: {
      get frames() { return shotFrames; },
      capture: () => canvas.toDataURL("image/png"),
      // A coarse numeric fingerprint of the frame. Two PNGs that differ by one
      // bit are "not identical" and nothing more; this is what lets the harness
      // say HOW different two runs were without shipping a PNG decoder.
      signature: (n: number) => {
        const c = document.createElement("canvas");
        c.width = n;
        c.height = n;
        const g = c.getContext("2d")!;
        g.drawImage(canvas, 0, 0, n, n);
        return Array.from(g.getImageData(0, 0, n, n).data);
      },
      /** Start a fresh timing window, so warm-up frames are not in the sample. */
      resetTiming: () => { timedFrames = 0; },
      get timed() { return timedFrames; },
      // Mean and p99, never the median.
      //
      // The median is what this used to report, and it lied by a factor of five.
      // Any sync point in the frame loop (the sky probe's GPU readback is one)
      // blocks on the WHOLE queued pipeline: uncapped, this renderer runs about
      // twenty frames ahead, so one frame in ~45 absorbs ~100 ms and the CPU
      // then races through the rest. The median lands in the race and collapses,
      // so adding the probe appeared to make the renderer FASTER (4.9 ms down
      // to 0.5 ms). Real cost was +0.1 ms, from frames over wall time.
      //
      // A cost metric that improves when you add work is worse than no metric,
      // so the mean is the headline and p99 is reported beside it to make a
      // stall visible instead of averaging it away.
      frameMs: () => {
        const n = timedFrames;
        if (n === 0) return { mean: 0, p99: 0 };
        const a = Array.from(frameRing.slice(0, n));
        const mean = a.reduce((x, y) => x + y, 0) / n;
        const sorted = a.sort((x, y) => x - y);
        return { mean, p99: sorted[Math.min(n - 1, Math.floor(n * 0.99))] };
      },
      /** Pavement triangles actually built, so the harness can say whether the
       *  kerbs are in the frame rather than assuming they are. */
      get pavementTriangles() { return pavement ? pavement.stats.triangles : 0; },
      /** The street: columns standing, cars moving, cars parked, and what the
       *  three of them cost. Reported separately from the total because "is
       *  there any traffic in this frame at all" is the first question to ask
       *  of a before/after pair, and a total cannot answer it. */
      get lamps() { return lamps ? lamps.stats.count : 0; },
      get lampsMeasured() { return lamps ? lamps.stats.measured : 0; },
      get cars() { return traffic ? traffic.stats.count : 0; },
      get parkedCars() { return parkedCars ? parkedCars.stats.count : 0; },
      /** Instances the fields wanted and could not hold. Reported because the
       *  first version of the archetype split clipped 185 parked cars on one
       *  pose and said nothing; a number nobody can see is a budget nobody can
       *  argue with. */
      get streetClipped() {
        return (
          (lamps ? lamps.stats.clipped : 0) +
          (traffic ? traffic.stats.clipped : 0) +
          (parkedCars ? parkedCars.stats.clipped : 0)
        );
      },
      get streetTriangles() {
        return (
          (lamps ? lamps.stats.triangles : 0) +
          (traffic ? traffic.stats.triangles : 0) +
          (parkedCars ? parkedCars.stats.triangles : 0)
        );
      },
      /** Triangles in ONE lamp and in each car archetype, so the harness can
       *  say what a count costs without hard-coding either. */
      get streetUnitTriangles() { return [LAMP_TRIANGLES, ...CAR_TRIANGLES]; },
      get triangles() {
        return (
          (buildings ? buildings.stats.triangles : 0) +
          (foliage ? foliage.stats.triangles : 0) +
          (live ? live.stats.triangles : 0) +
          (lamps ? lamps.stats.triangles : 0) +
          (traffic ? traffic.stats.triangles : 0) +
          (parkedCars ? parkedCars.stats.triangles : 0)
        );
      },
      /** What the live path has managed to fetch and build. The harness waits
       *  on this: a pose over an unbaked place is not worth capturing until
       *  something has actually streamed in. */
      get liveTiles() { return live ? live.stats.tiles : 0; },
      /** True once the scheduler has nothing left to ask about, which is the
       *  only point at which the frame shows everything this place has. */
      get liveIdle() { return live ? !live.stats.fetching && live.pending === 0 : true; },
      get liveBuildings() { return live ? live.stats.buildings : 0; },
      get liveStats() {
        return live
          ? { ...live.stats, latency: live.latency(), overpass: { ...live.overpass.stats, latencyMs: undefined } }
          : null;
      },
      get trees() { return foliage ? foliage.stats.count : 0; },
      /** Instances at each level of detail, and their triangles. The frame
       *  budget for the canopy is decided here, so the harness can see it. */
      get treeLods() { return foliage ? foliage.stats.lodCounts : []; },
      get treeTriangles() { return foliage ? foliage.stats.triangles : 0; },
      get lod() { return buildings ? buildings.stats.lod : 0; },
      /** True while the detail ring is fetching. A frame captured mid-stitch
       *  would show the drape the ring is about to replace. */
      get drapePending() { return detailRing.stats.pending; },
      get drapeMoves() { return detailRing.stats.moves; },
    },
    flyby: {
      scene, camera, renderer, terrain, sky, city, tune, buildings, roads, composite, ac, chase,
      sunShadow, drone, skyProbe, ao, car, detailRing,
      get droneActive() { return droneActive; },
      get carActive() { return carActive; },
      get wx() { return wx; },
      get time() { return now; },
      /**
       * What the traffic model believes, for the primary class.
       *
       * The one visible number that says the model is running: a frac that
       * never moves as the scrubber crosses 03:00, or a speed stuck at 1 in a
       * downpour, is a dead parameter table and looks exactly like a working
       * one from the air. `?diag=1` prints it.
       */
      get trafficModel() {
        return {
          localHour: localHour(now, trafficUtcOffset),
          frac: trafficNow.frac[RoadClass.Primary],
          speed: trafficNow.speed[RoadClass.Primary],
        };
      },
      setOffsetHours: (h: number) => timebar.setOffset(h * 3600),
      setExposure: (v: number) => (exposureScale = v),
    },
  });

  // An escape hatch, always available.
  //
  // Tiles, packs and weather live in IndexedDB for up to thirty days, so a
  // reader who has hit a bad bake, a half-written pack or simply wants to prove
  // they are seeing current data has no way to force a refetch short of finding
  // the storage panel in devtools. `clearCache` existed for exactly this and was
  // exported but never wired to anything, which made it dead code AND a missing
  // feature at the same time.
  //
  // It does NOT clear the HTTP cache, and that distinction matters when
  // diagnosing "am I on an old build": the JS bundle is a hashed filename served
  // by the CDN, so stale CODE is always a stale index.html, never IndexedDB.
  Object.assign(window as unknown as Record<string, unknown>, {
    flybyClearCache: async () => {
      await clearCache();
      console.info("[flyby] tile cache cleared; reload to refetch");
    },
  });

  // A developer's instrument, on the same switch as the frame counter: it costs
  // a GPU stall to answer and nothing on the page should pay that unasked.
  if (showPerf) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __cloudMetric: () => composite.measureBanding(renderer),
      __aoMetric: () => ao.measure(renderer),
    });
  }
}

main().catch((err) => {
  console.error(err);
  const d = document.getElementById("loading");
  if (d) d.querySelector(".step")!.textContent = `failed: ${err.message}`;
});
