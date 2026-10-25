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
import { ThrottleSlider } from "./app/throttle";
import { ModeBar } from "./app/modebar";
import { DroneModel } from "./render/dronemodel";

const DEG2RAD = Math.PI / 180;
const _droneLook = new THREE.Euler();
const _droneOffset = new THREE.Vector3();
import { Hud, LoadingScreen } from "./app/hud";
import { showMenu } from "./app/menu";
import { Aircraft, DEFAULT_CONFIG, EASY_CONFIG, chooseStartAltitude } from "./sim/aircraft";
import { ChaseCam, CAMERA_MODES } from "./sim/chasecam";
import { Drone, DRONE_RADIUS } from "./sim/drone";
import { Car, CAR_NEAR_PLANE_M } from "./sim/car";
import { buildRoadGraph, laneOffsetM, type RoadGraph } from "./data/roadgraph";
import { buildBridgeDecks } from "./data/bridgedeck";
import {
  densifyLandmarkWays,
  landmarkDeckPin,
  landmarkSuppresses,
  landmarksFor,
  promoteLandmarkApproaches,
  snapLandmarkAxes,
} from "./data/landmarks";
import { Bridges } from "./render/bridges";
import { DetailRing } from "./render/detailring";
import { CityCollision } from "./sim/citycollision";
import { Input } from "./sim/input";
import { AircraftModel } from "./render/aircraftmodel";
import { Osd } from "./app/osd";
import { Minimap } from "./app/minimap";
import { Timebar, LocalClock } from "./app/timebar";
import { Beacon } from "./render/beacon";
import { loadCityPack } from "./data/citypack-load";
import { Buildings, flattenParts } from "./render/buildings";
import { hourFactors } from "./render/facade";
import { buildUrbanMask, emptyUrbanMask, type UrbanMask } from "./render/urbanmask";
import { buildRoadMask, emptyRoadMask, type RoadMask } from "./render/roadmask";
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
} from "./data/trafficmodel";
import { StreetLamps, LAMP_TRIANGLES } from "./render/streetlamps";
import type { StreetLampUniforms } from "./render/streetlamps";
import { ParkedCars, Traffic, CAR_TRIANGLES } from "./render/traffic";
import { pixelAngle } from "./render/glowpoints";
import { ledShare, streetLightUniforms } from "./render/streetlight";
import { measureLanes } from "./sim/lanecheck";
import { junctionCaps } from "./data/junctioncaps";
import { medianPieces } from "./data/medians";
import { buildLandMask, emptyLandMask, type LandMask } from "./render/landmask";
import { WaterHistory } from "./render/waterssr";
import { Foliage, SHRUB_FOLIAGE, TREE_LOD_TRIANGLES } from "./render/trees";
import { buildLandMaskRGBA, waterLevelM } from "./data/landmask";
import { buildShrubMaskRGBA, placeShrubs, shrubFieldExtentM, type ShrubField } from "./data/shrubs";
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
import { StreetSignHud } from "./app/streetsign";
import { streetSign } from "./data/streetsign";
import { Layers } from "./app/layers";
import { Places, type PlaceRow } from "./app/places";
import { Autopilot } from "./sim/autopilot";
import { EasyStick } from "./sim/easystick";
import { fetchNearby, searchNamedPlaces } from "./data/nearby";
import { AirTrafficLayer } from "./app/airtraffic";
import { SpotGame } from "./app/spotgame";
import { TransitLayer } from "./app/transit";
import { AIRPORTS, airportById, spotPose } from "./data/airports";
import { haversine } from "./geo";
import { prof, installObjectProfiling } from "./render/gpuprof";

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
  // `?spot=lga` alone is a flight over the baked city the airport shares a
  // sky with, the same as the menu card for it.
  const spot = airportById(params.get("spot") ?? "");
  if (!q && spot) return cityById(spot.cityId) ?? cityAt(spot.lat, spot.lon);
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
 * `?wx=low:0.95:900:2100,mid:0:3800:5000,high:0:8500:9400,precip:0,wind:11:270` pins the
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
    } else if (key === "wind") {
      // `wind:speed:fromDeg`, so a pose can pin a sea state. The default
      // 4 m/s is Beaufort 3, which by design has no whitecaps to look at.
      out.windSpeed = Math.max(0, num(1, out.windSpeed));
      out.windDir = num(2, out.windDir);
      out.gust = Math.max(out.gust, out.windSpeed * 1.4);
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
  // The driver's-seat dash: a dark silhouette along the bottom of the frame
  // with the curve of a bonnet's leading edge in it. Drawing the player's
  // car from inside its own body put the cabin's pillars, clipped by the
  // near plane, across the windscreen; a silhouette says "you are in a car"
  // and costs nothing. Outside #ui, so `?shot` frames have it too.
  const dash = document.createElement("div");
  dash.id = "dash";
  canvas.insertAdjacentElement("afterend", dash);
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
  // `?gpuprof` times every pass on the GPU, `?gpuprof=objects` the main pass
  // object by object as well; tools/profile.ts reads both back.
  const profQ = new URLSearchParams(location.search).get("gpuprof");
  if (profQ !== null) prof.init(renderer.getContext() as WebGL2RenderingContext, profQ === "objects", profQ === "frame");

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
  // The three cloud flags are tools/verify-clouds.ts's measurement frame and
  // its two vacuity probes; see render/composite.ts.
  const cloudQ = new URLSearchParams(location.search);
  const composite = new Composite(renderer, {
    tier: budget.tier,
    debug: cloudQ.get("clouddebug") === "1",
    uniformCoverage: cloudQ.get("cloudwm") === "0",
    oldBase: cloudQ.get("cloudflatbase") === "0",
    benchRepeats: Number(cloudQ.get("cloudbench") ?? 0) || 0,
    probe: cloudQ.get("cloudprobe") ?? "",
  });
  const target = createSceneTarget(renderer, budget);
  // The previous frame, for the water's screen-space reflections.
  const waterHistory = new WaterHistory(renderer);
  // Screen-space sky occlusion. Runs before the main pass, because the surface
  // shaders read its result rather than the composite doing so; see render/ao.ts.
  const ao = new AoPass(renderer);
  const quality = new AdaptiveQuality(renderer, budget.tier, {
    ssr: budget.tier !== "reduced",
    ao: budget.aoEnabled,
    fullClouds: budget.tier === "full",
    bigShadows: budget.shadowCascadeCount > 2 || budget.shadowCascadeSize > 1024,
    msaa: budget.msaaSamples > 0,
  });
  // Passes and scene groups switched off, by name: `?off=ao,clouds,buildings`
  // or flybyShot.setOff at run time. tools/profile.ts attributes the frame by
  // taking each one away in turn, because the timer queries on this GPU
  // overlap and sum to twice the frame (see render/gpuprof.ts).
  const perfOff = new Set((new URLSearchParams(location.search).get("off") ?? "").split(",").filter(Boolean));
  const perfHidden: THREE.Object3D[] = [];
  const probeHidden: THREE.Object3D[] = [];
  const perfSync = new URLSearchParams(location.search).has("perfsync");
  const perfSyncPixel = new Uint8Array(4);
  composite.skip = perfOff;

  const resizeTargets = () => {
    const s2 = renderer.getDrawingBufferSize(new THREE.Vector2());
    target.setSize(s2.x, s2.y);
    waterHistory.resize(renderer);
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
  const driveFromShot = new URLSearchParams(location.search).has("drive");
  const headlightsOff = new URLSearchParams(location.search).has("noheadlights");
  const lampLightOff = new URLSearchParams(location.search).has("nolamplight");
  const forceHighBeam = new URLSearchParams(location.search).has("highbeam");
  let driveEntered = false;
  const _driveFrom = new THREE.Vector3();
  const _driveStill = new THREE.Vector3();
  const pinScale = Number(new URLSearchParams(location.search).get("scale"));
  if (Number.isFinite(pinScale) && pinScale > 0) {
    quality.pin(pinScale);
    quality.apply(renderer);
    renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
    resizeTargets();
  }
  // `?qlevel=N`: hold step N of the quality ladder, features and scale, for
  // tools/profile.ts. Outranks `?scale`.
  const qLevel = new URLSearchParams(location.search).get("qlevel");
  if (qLevel !== null) {
    quality.force(Number(qLevel));
    quality.apply(renderer);
    target.samples = quality.features.msaa ? budget.msaaSamples : 0;
    target.dispose();
    renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
    resizeTargets();
  }
  if (shotMode) ui.style.display = "none";

  const sky = new Sky();
  sky.mesh.name = "sky";
  scene.add(sky.mesh);

  // Sun shadows. Constructed before anything that reads them, because the
  // cascade uniforms are spread by reference into the terrain and building
  // materials at the moment those materials are created.
  const sunShadow = new SunShadow(budget);
  composite.attachShadow(sunShadow.uniforms);
  // One environment probe for the whole scene: sky irradiance for every diffuse
  // surface and a prefiltered cube for the glass and the wet tarmac.
  const skyProbe = new SkyProbe();
  skyProbe.hold = shotMode;
  if (new URLSearchParams(location.search).get("shadows") === "0") sunShadow.enabled = false;
  // Whether this device gets ambient occlusion at all is render/budget.ts's
  // call; the query parameters below still override it either way, because
  // forcing it on is how the phone case gets tested from a desktop.
  const params = new URLSearchParams(location.search);
  ao.enabled = budget.aoEnabled;
  if (params.get("ao") === "0") ao.enabled = false;
  if (params.get("ao") === "1") ao.enabled = true;
  // What the tier and the flags allow; the quality ladder may only take away.
  const aoBase = ao.enabled;

  // The plan the drapes were stitched for. Defaulting to CITY_RINGS here gave a
  // reduced-tier device the desktop meshes under its own smaller drapes.
  const terrain = new Terrain(origin, fields, drapes, sunShadow.uniforms, budget.rings);
  terrain.group.name = "terrain";
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
  // The landmark bridges, hand-built in render/bridgemesh.ts. The OSM parts
  // they replace (the Golden Gate's tower legs are ten building:parts) go
  // before anything sees the pack: the renderer, the collider and the tree
  // mask all have to agree that the tower is the bridge's and not a building.
  const landmarks = landmarksFor(city.id, origin);
  if (pack && landmarks.length) {
    const before = pack.buildings.length;
    pack.buildings = pack.buildings.filter((b) => !landmarkSuppresses(landmarks, b));
    console.log(`[flyby] landmarks: ${landmarks.length} bridges, ${before - pack.buildings.length} OSM parts replaced`);
  }
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
  // `?flatparts=1`: towers back to boxes, the probe for the skyline claim in
  // tools/verify-buildings.ts. Dev builds only, like every gate flag.
  if (pack && import.meta.env.DEV && new URLSearchParams(location.search).get("flatparts") === "1") {
    pack.buildings = flattenParts(pack.buildings);
  }
  if (pack && !buildingsOff) {
    buildings = new Buildings(pack, terrain.heightAt, sunShadow.uniforms, budget);
    buildings.group.name = "buildings";
    scene.add(buildings.group);
    // `?nocityshadow=1` and `?cityshadowonly=1` are the probe and the reference
    // for tools/verify-shadow.ts.
    if (!new URLSearchParams(location.search).has("nocityshadow")) sunShadow.setCityCasters(buildings.group);
    sunShadow.cityOnly = new URLSearchParams(location.search).has("cityshadowonly");
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
  let bridges: Bridges | null = null;
  // Where every bridge deck is, solved ONCE. Both the ribbon below and the car
  // further down read it, which is the whole reason it is not solved inside
  // either of them; see data/bridgedeck.ts.
  // A landmark's own ways are reshaped first (see data/landmarks.ts): the
  // stretch of Yerba Buena approach that is mapped as plain road is promoted
  // to the bridge it is on, and every way on a landmark is densified so its
  // deck can follow a vertical curve. Before the decks, the graph and the
  // ribbon, so all three see the same ways.
  if (roadPack && landmarks.length) {
    snapLandmarkAxes(landmarks, roadPack.roads);
    const promoted = promoteLandmarkApproaches(roadPack.roads, landmarks);
    const added = densifyLandmarkWays(roadPack.roads, landmarks);
    console.log(`[flyby] landmark ways: ${promoted} promoted to bridge, ${added} vertices added`);
  }
  const bridgeDecks = roadPack
    ? buildBridgeDecks(roadPack.roads, terrain.heightAt, roadPack.radiusM, landmarkDeckPin(landmarks))
    : null;
  if (bridgeDecks) {
    const bs = bridgeDecks.stats;
    console.log(
      `[flyby] bridge decks: ${bs.bridgeWays} ways in ${bs.chains} chains, ` +
      `${bs.abutments} abutments, ${bs.orphanChains} orphan ` +
      `(${bs.orphanChainsLifted} lifted, ${bs.orphanChainsDraped} draped), ` +
      `longest chain ${bs.longestChainM.toFixed(0)} m, ${bs.buildMs} ms`,
    );
  }
  // Built before the ribbons, which cap their junctions from it; see
  // data/junctioncaps.ts.
  const roadGraph: RoadGraph | null = roadPack ? buildRoadGraph(roadPack.roads) : null;
  if (roadPack) {
    roads = new Roads(
      roadPack, terrain.heightAt, sunShadow.uniforms, budget, bridgeDecks!.deck,
      roadGraph ? junctionCaps(roadGraph) : [],
      medianPieces(roadPack.roads),
    );
    roads.group.name = "roads";
    scene.add(roads.group);
    const rs = roads.stats;
    console.log(
      `[flyby] roads: ${rs.drawn} drawn of ${roadPack.roads.length} ` +
      `(${rs.skippedFar} out of class range, ${rs.skippedTunnel} tunnels, ${rs.skippedShort} stubs), ` +
      `${rs.bridges} bridges, ${rs.triangles} triangles in ${rs.meshes} meshes, ` +
      `lod ${rs.lod}, ${rs.buildMs.toFixed(0)} ms`,
    );
    if (landmarks.length) {
      bridges = new Bridges(landmarks, roadPack, bridgeDecks!.deck, terrain.heightAt, sunShadow.uniforms);
      bridges.group.name = "bridges";
      scene.add(bridges.group);
      const b = bridges.stats;
      console.log(
        `[flyby] bridges: ${b.bridges} landmarks, ${b.triangles} triangles ` +
        `(${b.nearTriangles} near only), ${b.buildMs.toFixed(0)} ms`,
      );
    }
  } else {
    console.warn(`[flyby] no road pack for ${city.id}; run: bun tools/bake-roads.ts --city ${city.id}`);
  }

  // The driveable network, for the car. Derived from the same pack the ribbons
  // are drawn from, so what you can drive on is what you can see. A city with
  // no .roads pack simply has no car, the same way it has no skyline.
  // Kept alongside the car because the street sign walks it, and the car owns
  // its graph privately.
  const car = roadGraph ? new Car(roadGraph) : null;
  if (car && bridgeDecks) car.setBridgeDecks(bridgeDecks.deck);
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
  // The understorey: shrub mounds from the shrubland class, drawn by the same
  // instanced canopy code with its own lattice and ranges.
  let shrubs: Foliage | null = null;
  // Both of the above once built, for the frame loop to walk without
  // allocating a list per frame.
  const canopies: Foliage[] = [];

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
  // The bridges light like street furniture and take the same per-frame feed.
  if (bridges) streetUniformSets.push(bridges.uniforms);

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
    if (shrubs) ao.apply(shrubs.uniforms, strength);
    if (lamps) ao.apply(lamps.uniforms, strength);
    if (traffic) ao.apply(traffic.uniforms, strength);
    if (parkedCars) ao.apply(parkedCars.uniforms, strength);
    if (bridges) ao.apply(bridges.uniforms, strength);
  };

  // Where the city actually is, for night lighting. A place with no pack gets
  // an all-dark mask: unlit open country is a more honest answer than guessing
  // from the daylight imagery and lighting up the whole map.
  const urban: UrbanMask = pack ? buildUrbanMask(pack) : emptyUrbanMask();

  // Where the carriageways are, so ground grass stops at the kerb instead of
  // running over it. The landcover posting is 10 m and a suburban street is one
  // texel of it; the road pack is the only thing in the scene that knows better.
  // Only four cities have a .roads pack, so the empty mask is the common path
  // and it leaves the terrain exactly as it was.
  const roadMask: RoadMask = roadPack ? buildRoadMask(roadPack) : emptyRoadMask();
  if (roadMask.has) {
    console.log(
      `[flyby] road mask: ${(roadMask.bytes / 1048576).toFixed(2)} MiB, ` +
        `${roadMask.cellM.toFixed(2)} m/texel over +-${roadMask.extent} m`,
    );
  }

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

  // A GATE FLAG IS NOT A FEATURE FLAG, and the difference is enforced here
  // rather than by everyone remembering it.
  //
  // Each of the three below turns one shipped fix OFF, and exists for exactly
  // one reason: tools/verify-water.ts and tools/verify-glass.ts have to run the
  // OLD behaviour in the SAME binary, or their assertions pass whatever the
  // shader does. They are not options, there is no UI for them, and the fixed
  // version is what everyone gets.
  //
  // `import.meta.env.DEV` is what keeps them from becoming options by accident:
  // tools/shots.ts spawns `vite` dev, so the gates can still reach them, and a
  // production build strips the branch and the flag with it.
  const gateFlag = (name: string): boolean =>
    import.meta.env.DEV && new URLSearchParams(location.search).get(name) === "1";
  /** The same rule for a flag with more than two states, e.g. buildingDebug=2. */
  const gateNum = (name: string): number =>
    import.meta.env.DEV ? Number(new URLSearchParams(location.search).get(name) ?? 0) || 0 : 0;

  // `?flatwater=1` restores the water this repo had before the wave normal: one
  // shared terrain normal over the whole surface and a constant ambient
  // reflection. It is the vacuity probe for tools/verify-water.ts, which has to
  // be able to run the OLD behaviour in the SAME binary and see its assertions
  // go red -- an assertion that passes both ways is measuring nothing.
  const flatWater = gateFlag("flatwater");

  // `?nossr=1` turns off the water's scene reflection and leaves the sky
  // reflection alone. It is the vacuity probe for the reflection assertion in
  // tools/verify-water.ts, which needs the waves and everything else exactly
  // as they are and only the mirrored skyline gone.
  // Off on the reduced tier: the history copy and the march cost a phone more
  // than the reflection is worth at its resolution.
  waterHistory.enabled = !gateFlag("nossr") && budget.tier !== "reduced";
  const ssrBase = waterHistory.enabled;

  // `?flatglass=1` restores the facade this repo had before the window reveal:
  // glazing exactly in the plane of the wall, with no parallax and no shadow
  // cast by the head or the jamb. It is the vacuity probe for
  // tools/verify-glass.ts, which has to run the OLD behaviour in the SAME
  // binary and see its assertions go red -- an assertion that passes either way
  // is measuring nothing.
  const flatGlass = gateFlag("flatglass");

  // `?buildingDebug=1` makes the building shader output its own facade mask, so
  // tools/verify-glass.ts does not have to guess which pixels are wall from
  // their colour. The terrain and the sky still draw normally, exactly as they
  // do under `?terrainDebug`, so the mask occludes what the beauty frame
  // occludes and the two agree pixel for pixel. `=2` narrows the same marker to
  // the fragments whose FACE is seen at a grazing angle, which is how the
  // Fresnel assertion in that tool splits one frame into two populations.
  const buildingDebug = gateNum("buildingDebug");

  // `?flatrefl=1` restores the facade reflection this repo had before the
  // glazing reflectance work: one bare-dielectric F0 of 0.04 on every family,
  // and the probe's open sunlit ground under every downward reflected ray. It
  // is the vacuity probe for the reflection assertions in
  // tools/verify-glass.ts, which has to run the OLD behaviour in the SAME
  // binary -- the reveal half of that tool already has `?flatglass=1`, and the
  // two are separate because they are separate claims about the same wall.
  const flatRefl = gateFlag("flatrefl");
  // `?flatfacade=1`: the pre-archetype facade, the probe for tools/verify-buildings.ts.
  const flatFacade = gateFlag("flatfacade");
  const oneRoof = gateFlag("oneroof");
  const noDetail = gateFlag("nodetail");
  const noMip = gateFlag("nomip");

  // `?flatbounce=1` restores the street floor this repo had before the canyon
  // bounce: a carriageway, a footway and a terrain drape that all went black
  // under lit towers at noon. It is the vacuity probe for
  // tools/verify-street.ts, which has to run the OLD behaviour in the SAME
  // binary and see its assertions go red.
  const flatBounce = gateFlag("flatbounce");

  // `?groundDebug=1` makes all three ground shaders emit their own street-floor
  // mask -- red where the ground is shadowed, blue where the sun reaches it --
  // so tools/verify-street.ts does not have to guess either from colour. Same
  // rule as `?buildingDebug`: the rest of the scene still draws normally, so
  // mask and beauty frame occlude alike and agree pixel for pixel.
  const groundDebug = gateNum("groundDebug");

  // `?nodetail=1`, `?detailtint=1` and `?detailalias=1` are the three probes
  // tools/verify-ground.ts runs against the ground detail layer: the drape
  // alone, the layer tinted so it no longer averages back to the photograph,
  // and the layer with its band limits removed. See uDetailMode in
  // render/terrain.ts.
  const detailMode = gateFlag("nodetail") ? 0
    : gateFlag("detailtint") ? 2
    : gateFlag("detailalias") ? 3
    : 1;

  // Where the far landcover level meets a cliff, the DEM decides; it needs to
  // know what height the water is at to do that. See uWaterLevel.
  const waterLevel = landPack
    ? waterLevelM(landPack.levels[1] ?? landPack.levels[0], terrain.heightAt) ?? 0
    : 0;

  for (const u of terrain.uniforms) {
    u.uDetailMode.value = detailMode;
    u.uWaterLevel.value = waterLevel;
    u.uUrban.value = urban.texture;
    u.uUrbanExtent.value = urban.extent;
    u.uLandNear.value = land.near;
    u.uLandFar.value = land.far;
    u.uLandNearExtent.value = land.nearExtent;
    u.uLandFarExtent.value = land.farExtent;
    u.uHasLand.value = land.has ? 1 : 0;
    u.uShoreNear.value = land.shoreNear;
    u.uShoreFar.value = land.shoreFar;
    u.uRoadMask.value = roadMask.texture;
    u.uRoadMaskExtent.value = roadMask.extent;
    u.uHasRoadMask.value = roadMask.has ? 1 : 0;
    if (Number.isFinite(terrainDebug)) u.uDebug.value = terrainDebug;
    u.uFlatWater.value = flatWater ? 1 : 0;
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
    pavement.group.name = "pavement";
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
      // The same solved decks the ribbon is drawn from, so a car on a bridge
      // stands on the bridge it can be seen on.
      deckOf: (i) => bridgeDecks?.deck[i] ?? null,
      occupied: pack ? (x, z) => treeFootprints.occupied(x, z) : null,
      onCarriageway: (x, z, except) => carriageways.blockedExcept(x, z, except),
      nearestMeasuredLamp: lampIndex
        ? (x, z, maxM) => lampIndex.nearest(x, z, maxM)
        : null,
    };

    lamps = new StreetLamps(roadPack, streetWorld, sunShadow.uniforms, budget, ledShare(city.id));
    lamps.group.name = "lamps";
    scene.add(lamps.group);
    if (roadGraph) {
      traffic = new Traffic(roadGraph, streetWorld, sunShadow.uniforms, budget);
      traffic.group.name = "traffic";
      scene.add(traffic.group);
    }
    parkedCars = new ParkedCars(roadPack, streetWorld, sunShadow.uniforms, budget);
    parkedCars.group.name = "parkedcars";
    scene.add(parkedCars.group);
    streetUniformSets.push(lamps.uniforms, parkedCars.uniforms);
    if (traffic) streetUniformSets.push(traffic.uniforms);
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
    foliage.group.name = "foliage";
    scene.add(foliage.group);
    canopies.push(foliage);
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

  // Shrubs, from the shrubland class the GPU mask folds into "herbaceous". The
  // far level is handed over too: shrubland is mostly OUTSIDE cities, and the
  // Marin headlands the Golden Gate pose looks at are past the near level's
  // 6 km. Off with `?noshrubs`, which is how their frame cost is measured.
  if (landPack && !new URLSearchParams(location.search).has("noshrubs")) {
    const t0 = performance.now();
    const nearL = landPack.levels[0];
    const farL = landPack.levels[1] ?? null;
    const field: ShrubField = {
      near: { rgba: buildShrubMaskRGBA(nearL), n: nearL.n, extentM: nearL.extentM },
      far: farL ? { rgba: buildShrubMaskRGBA(farL, false), n: farL.n, extentM: farL.extentM } : null,
      heightAt: terrain.heightAt,
      roads: treeRoads,
      footprints: treeFootprints,
    };
    shrubs = new Foliage(
      {
        extentM: shrubFieldExtentM(field),
        place: (x0, z0, x1, z1) => placeShrubs(field, x0, z0, x1, z1),
      },
      sunShadow.uniforms,
      budget.tier === "reduced",
      SHRUB_FOLIAGE,
    );
    shrubs.update(0, 0);
    shrubs.group.name = "shrubs";
    scene.add(shrubs.group);
    canopies.push(shrubs);
    const ss = shrubs.stats;
    console.log(
      `[flyby] shrubs: ${ss.count} instances (lod ${ss.lodCounts.join("/")}), ` +
      `${(ss.triangles / 1000).toFixed(0)}k triangles, ` +
      `${(performance.now() - t0).toFixed(0)} ms` +
      `${ss.clipped ? " (CLIPPED to the instance budget)" : ""}`,
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
      foliage.group.name = "foliage";
      scene.add(foliage.group);
      canopies.push(foliage);
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
  const throttleSlider = new ThrottleSlider(ui);
  const modeBar = new ModeBar(ui);

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
  //
  // And the name is a CONTROL, not a caption. `arriveAt` is declared below and
  // is only called from the click, which happens long after this line runs.
  const labels = new Labels(ui, (name) => {
    const p = nearby.find((r) => r.name === name);
    if (p) arriveAt(p);
  });
  const beacon = new Beacon();
  beacon.group.name = "beacon";
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
  //
  // 62 rather than the 70 it was: from 1.25 m a 70 degree lens stretched the
  // parked cars at the frame edges into wedges, and the owner's frames from
  // the car read as a wide-angle photograph rather than a windscreen.
  const CAR_FOV = 62;
  /** Chase view while driving: an odd count of CAM presses since the car was
   *  entered. The driver's seat is the default. */
  let carCamBase = 0;
  const carChase = (): boolean => carActive && ((input.cameraCycled - carCamBase) & 1) === 1;
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
  model.group.name = "model";
  scene.add(model.group);
  const droneModel = new DroneModel(model);
  droneModel.group.name = "dronemodel";
  scene.add(droneModel.group);

  const osd = new Osd(ui);
  const streetSignHud = new StreetSignHud(ui);

  // A heading-up moving map with a compass round it. Fed the footprints once;
  // after that it only needs where the aeroplane is and which way it points.
  const minimap = new Minimap(ui);
  // A city with no building pack still gets the compass and the landmarks.
  if (pack) minimap.setCity(pack);
  const layers = new Layers(ui);
  const airTraffic = new AirTrafficLayer({ scene, ui, model, origin, groundAt: terrain.heightAt, shotMode });
  // Trains and boats; see app/transit.ts.
  const transit = new TransitLayer({ scene, ui, model, origin, cityId: city.id, groundAt: terrain.heightAt, waterY: waterLevel, landmarks, shotMode });
  airTraffic.render.group.name = "airtraffic";
  const drawSize = new THREE.Vector2();
  // Plane spotting over the live traffic; see app/spotgame.ts.
  const spotGame = new SpotGame(ui, airTraffic, () => city.name);

  /**
   * Hover the drone beside the runway in use at an airport and watch.
   *
   * Spotted from inside the baked city's world rather than from a flight
   * centred on the airport: the city's land pack is what knows the runways
   * are land (see Airport.cityId), and the 400 m z18 detail ring follows a
   * camera under 40 m, so the apron under the drone is sharp anyway. Only an
   * airport outside this world (past 30 km, or another city's) reloads.
   */
  const spotAt = (id: string): void => {
    const a = airportById(id);
    if (!a) return;
    if (haversine(a, origin) > 30000) {
      const params = new URLSearchParams(location.search);
      params.delete("at");
      params.set("city", a.cityId);
      params.set("spot", a.id);
      location.search = params.toString();
      return;
    }
    // Height from the median of the runway's middle, not its threshold. The
    // DEM has a 28 m spike 110 m off LGA's runway 22 threshold (terrarium
    // z13, sampled 2026-10-24), where the runway runs out on a pier, and at
    // the z12 the near field loads it bleeds onto the threshold itself.
    const hAt = (lat: number, lon: number) => {
      const p = origin.toWorld(lat, lon);
      return terrain.heightAt(p.x, p.z);
    };
    const sides = ([1, -1] as const).map((sd) => spotPose(a, wx.windDir, sd));
    const { threshold: t0, far: t1 } = sides[0];
    const along = [0.3, 0.4, 0.5, 0.6, 0.7]
      .map((f) => hAt(t0.lat + (t1.lat - t0.lat) * f, t0.lon + (t1.lon - t0.lon) * f))
      .sort((p, q) => p - q);
    const thrY = along[2];
    const pose = sides.reduce((b, c) =>
      Math.abs(hAt(c.lat, c.lon) - thrY) < Math.abs(hAt(b.lat, b.lon) - thrY) - 2 ? c : b);
    const w = origin.toWorld(pose.lat, pose.lon);
    // The drone keeps its own clearance over whatever is under the spot.
    const y = thrY + pose.aglM;
    carActive = false;
    droneActive = true;
    drone.enterFrom(new THREE.Vector3(w.x, y, w.z), pose.hdgDeg, new THREE.Vector3());
    drone.pitchDeg = pose.pitchDeg;
    // Through the drone's own lens: the chase view parks the airframe in the
    // middle of the frame, which is exactly where the runway is.
    input.cameraCycled = CAMERA_MODES.indexOf("cockpit");
    autopilot.disengage();
    // Taxiing traffic is close and slow and every tag is worth reading.
    airTraffic.focus(a.lat, a.lon, 16);
    hud.toast(`${a.icao.slice(1)} runway ${pose.runway} \u00b7 drone hovering, live traffic on`);
  };

  // Places you can fly to, and something that flies you there. A list you can
  // only read is a list of things you now have to find by hand at a hundred
  // knots over a city you have never seen from the air.
  const autopilot = new Autopilot();
  // Before the autopilot in the chain, so a place picked from the list still
  // flies itself once the thumb is off and the stick has eased back.
  const easyStick = new EasyStick();
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
    if (p.spot) {
      spotAt(p.spot);
      return;
    }
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
  // The airports in this sky, as spots to watch from. 40 km takes in all
  // three around each listed city from its origin.
  for (const a of AIRPORTS) {
    if (haversine(a, origin) > 40000) continue;
    const w = origin.toWorld(a.lat, a.lon);
    curated.push({ name: `${a.icao.slice(1)} ${a.name} spotting`, x: w.x, z: w.z, topY: terrain.heightAt(w.x, w.z) + 120, spot: a.id });
  }
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

  {
    const spot = new URLSearchParams(location.search).get("spot");
    if (spot) spotAt(spot);
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
  const bridgeBufferSize = new THREE.Vector2();

  // The animation clock as of the last traffic step; see the step below.
  let lastElapsed = 0;
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
  // `?perfbench`'s per-batch costs; see below.
  let benchTimed = 0;
  const benchRing = new Float64Array(600);

  const frameBody = (): void => {
    // The RAW delta is what the frame-cost metric records; `dt` is the clamped
    // one the simulation integrates with. Keeping them separate is the whole
    // point: the clamp exists so one long stall cannot teleport the aeroplane
    // through a building, and feeding the clamped value to the metric made p99
    // report the CLAMP. It came back as exactly 50.00 ms for every pose in
    // every build, which is a tail metric that cannot distinguish anything.
    const rawDt = clock.getDelta();
    const dt = Math.min(0.05, rawDt);
    prof.cpuBegin("frame");
    prof.begin("frame");
    if (prof.objects && shotFrames % 30 === 0) installObjectProfiling(scene);
    // The animation clock stays at zero for a screenshot. It drives the cloud
    // drift, the sky and the beacon, and a wall-clock-derived phase is the one
    // thing that would make two runs of the same URL differ.
    if (!shotMode) elapsed += dt;

    // `?drive=1` with a pinned `?cam=`: start IN THE CAR at that pose. The
    // street-level gates (tools/verify-night.ts) and the before/after shots of
    // a drive have to photograph what the driver sees, including the car's
    // own headlights and its lane, and a free camera at eye height has neither.
    if (driveFromShot && shotCam && car && !carActive && !driveEntered) {
      driveEntered = true;
      const w = origin.toWorld(shotCam.lat, shotCam.lon);
      _driveFrom.set(w.x, shotCam.altM, w.z);
      if (car.enterFrom(_driveFrom, shotCam.hdgDeg, _driveStill, terrain.heightAt)) {
        carActive = true;
        // `?drive=1&chase=1` starts in the chase view, for the shots.
        carCamBase = input.cameraCycled - (new URLSearchParams(location.search).has("chase") ? 1 : 0);
      }
    }

    // --- Which machine is flying ------------------------------------------
    // A tap on the picker is turned into the same toggles V and G raise, so
    // there is one code path for every way of switching.
    {
      const want = modeBar.take();
      const now = carActive ? "car" : droneActive ? "drone" : "plane";
      if (want && want !== now) {
        if (want === "plane") {
          if (droneActive) input.droneToggled++;
          if (carActive) input.carToggled++;
        } else if (want === "drone") input.droneToggled++;
        else input.carToggled++;
      }
    }
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
          carCamBase = input.cameraCycled;
          droneActive = false;
          input.setPointerLock(true);
          hud.toast("Car: W/S drive \u00b7 A/D steer and pick the turning \u00b7 mouse looks \u00b7 G to get out");
        } else {
          hud.toast("No road within reach \u00b7 fly closer to a street");
        }
      }
    }

    const sampled = input.sample(dt);
    const eased = easyStick.update(sampled, input.easyFinger, ac.rollDeg, dt);
    const axes = autopilot.update(
      eased,
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
      if (!input.paused) car.update(ci, dt, terrain.heightAt, traffic?.sim ?? null);
    }

    hud.setLayers(layers.weather);
    osd.root.style.display = layers.instruments ? "" : "none";

    // NOT WHILE DRIVING. From a car the landmark labels are at eye level and
    // three deep across the windscreen, naming towers a mile off that you are
    // not going to reach at 20 knots down a one-way street. The list stays --
    // it is off to the side and it is how you leave -- but the world stops
    // being annotated.
    labels.visible = layers.landmarks && !carActive;
    places.setVisible(layers.landmarks);

    // What road is this, and what am I coming to. Only the car has an answer:
    // the aeroplane is not on the graph and the drone has left it.
    streetSignHud.update(
      carActive && car && roadGraph && car.track
        ? streetSign(roadGraph, car.track.half, car.track.s)
        : null,
    );
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
      transit.tags ? [...airTraffic.tags.rects, ...transit.tags.rects] : airTraffic.tags.rects,
    );

    if (input.helpToggled > 0) {
      input.helpToggled = 0;
      hud.toggleControls();
    }

    chase.mode = CAMERA_MODES[input.cameraCycled % CAMERA_MODES.length];
    if (carActive && car) {
      camera.up.set(0, 1, 0);
      dash.style.display = carChase() ? "none" : "block";
      if (carChase()) {
        car.chaseEye(camera.position, camera.quaternion);
      } else {
        // Straight off the car, like the drone: the camera IS the driver's
        // head, in the driver's seat over the carriageway.
        car.eye(camera.position);
        car.orientation(camera.quaternion);
      }
    } else if (droneActive) {
      dash.style.display = "none";
      camera.up.set(0, 1, 0);
      if (chase.mode === "cockpit") {
        // FPV: the camera IS the machine, and the lean it has is the lean it
        // flew. One CAM tap away from the default.
        camera.position.copy(drone.position);
        drone.orientation(camera.quaternion);
      } else {
        // The default: a chase shot of the airframe, so the drone is a thing
        // you can see. Rigid to the look (yaw and pitch), not the lean, so
        // the machine visibly banks and noses into its moves in frame.
        _droneLook.set((drone.pitchDeg - 10) * DEG2RAD, -drone.yawDeg * DEG2RAD, 0, "YXZ");
        camera.quaternion.setFromEuler(_droneLook);
        _droneOffset.set(0, 1.1, 4.5).applyQuaternion(camera.quaternion);
        camera.position.copy(drone.position).add(_droneOffset);
      }
    } else {
      dash.style.display = "none";
      chase.update(camera, ac, dt, input.lookBack, terrain.heightAt(camera.position.x, camera.position.z));
    }

    // A pinned lens overrides whichever rig just ran. Heading is a COMPASS
    // bearing and the Euler about +y runs the other way, the same sign trap
    // Aircraft.reset carries a note about.
    if (shotCam && !carActive) {
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
      prof.cpuBegin("drape");
      detailRing.follow(camera.position.x, camera.position.z, vx, vz);
      prof.cpuEnd("drape");
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

    droneModel.group.visible = droneActive && chase.mode !== "cockpit" && !shotCam;
    if (droneModel.group.visible) {
      droneModel.group.position.copy(drone.position);
      drone.bodyOrientation(droneModel.group.quaternion);
      droneModel.update(dt, shotMode);
    }
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
    //
    // The blend fraction alone was not enough. The rig writes the blended
    // position back into its own spring every frame, so a held blend compounds:
    // at a nominal 0.2 the camera already sat in the cabin with the airframe
    // drawn round it (the owner's phone, low over SF, showed struts and wheels
    // sliced across the frame). So the camera's real distance decides too: the
    // airframe's envelope is about 6 m from the datum at the tail and the
    // wingtips, and a lens inside it must never see the shell.
    const insideAirframe = camera.position.distanceTo(ac.position) < 6.5;
    model.group.visible =
      !shotCam &&
      (droneActive || carActive ||
        (chase.mode !== "cockpit" && chase.cockpitBlend < 0.45 && !insideAirframe));
    // Zeroed control surfaces while droning. W and A are the drone's now, and
    // a parked aeroplane waggling its ailerons at them looks haunted.
    const parked = droneActive || carActive;
    model.update(dt, ac.throttle, parked ? 0 : axes.roll, ac.pitchDeg, parked ? 0 : axes.yaw);

    // The beam stands on wherever you asked to go, and nowhere at all when you
    // have not asked. It used to mark the tour's next stop, which meant there
    // was always a beam and it was always somebody else's idea.
    const t = autopilot.target;
    beacon.update(
      t && layers.landmarks && !carActive
        ? { x: t.x, z: t.z, groundY: terrain.heightAt(t.x, t.z) }
        : null,
      elapsed,
      t ? Math.hypot(t.x - ac.position.x, t.z - ac.position.z) : 0,
    );

    const solar = solarState(now, city.lat, city.lon);
    const light = computeLighting(solar, wx);

    renderer.getDrawingBufferSize(drawSize);
    prof.cpuBegin("airtraffic");
    airTraffic.update(camera, drawSize.y, dt, light.night, layers.traffic, droneActive ? drone.position : carActive ? undefined : ac.position);
    prof.cpuEnd("airtraffic");
    {
      const me = carActive && car ? car.position : droneActive ? drone.position : ac.position;
      const hdg = carActive && car ? car.headingDeg : droneActive ? drone.yawDeg : ac.headingDeg;
      prof.cpuBegin("spotgame");
      spotGame.update(camera, dt, { x: me.x, y: me.y, z: me.z, headingDeg: hdg }, layers.traffic);
      prof.cpuEnd("spotgame");
      minimap.setTraffic(layers.traffic ? spotGame.near : []);
    }
    prof.cpuBegin("transit");
    transit.update(camera, drawSize.y, dt, light.night, layers.trains, layers.boats, airTraffic.tags.rects);
    prof.cpuEnd("transit");
    minimap.setTransit(transit.blips);
    spotGame.transit = transit.blips;

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
      // Every frame, not once at start-up: a terrain ring built later gets its
      // own uniform set, and it must not be the one ring with no bounce in it.
      u.uUrban.value = urban.texture;
      u.uUrbanExtent.value = urban.extent;
      u.uFlatBounce.value = flatBounce ? 1 : 0;
      u.uGroundDebug.value = groundDebug;
      u.uMieG.value = light.mieG;
      u.uTurbidity.value = light.turbidity;
      u.uCamAltitude.value = camAlt;
      u.uExposure.value = light.exposure * exposureScale;
      // The waves. `elapsed` is frozen in shot mode, so a screenshot of moving
      // water is still byte-reproducible; the wind is the same observation the
      // clouds drift on, converted from the meteorological "comes FROM"
      // bearing to an (east, south) velocity exactly as composite.ts does.
      u.uTime.value = elapsed;
      const windTo = (wx.windDir + 180) * (Math.PI / 180);
      u.uWind.value.set(Math.sin(windTo) * wx.windSpeed, -Math.cos(windTo) * wx.windSpeed);
    }
    sky.uniforms.uExposure.value = light.exposure * exposureScale;

    // Local SOLAR hour, from UTC and the longitude, rather than the civil
    // hour: it needs no timezone database, it is what the sun is actually
    // doing, and the lights coming on want to track the evening rather than
    // a political line on a map.
    const localHour =
      (now.getUTCHours() + now.getUTCMinutes() / 60 + city.lon / 15 + 24) % 24;
    const hf = hourFactors(localHour);
    // ?nodetail=1: no camera-centred detail layer, a probe for the gates.
    if (!noDetail) buildings?.updateDetail(camera.position.x, camera.position.z);
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
      // Written every frame rather than once at start-up, because streamed
      // tiles add their own uniform set to this array long after that.
      b.uFlatGlass.value = flatGlass ? 1 : 0;
      b.uFlatRefl.value = flatRefl ? 1 : 0;
      b.uFlatFacade.value = flatFacade ? 1 : 0;
      b.uOneRoof.value = oneRoof ? 1 : 0;
      b.uFlatShop.value = gateFlag("flatshop") ? 1 : 0;
      b.uMatNoMip.value = noMip ? 1 : 0;
      b.uTerrainDebug.value = terrainDebug || 0;
      b.uUrban.value = urban.texture;
      b.uUrbanExtent.value = urban.extent;
      b.uBuildingDebug.value = buildingDebug;
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
      r.uFlatBounce.value = flatBounce ? 1 : 0;
      r.uGroundDebug.value = groundDebug;
      // Same reason as the buildings above: the pavement pushes its own uniform
      // set into this array long after start-up, and streamed road tiles share
      // this one, so the mask is written every frame rather than once.
      r.uUrban.value = urban.texture;
      r.uUrbanExtent.value = urban.extent;
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
    prof.cpuBegin("live");
    live?.update(camera.position.x, camera.position.z);
    prof.cpuEnd("live");

    // Keep the kerbs under the camera. Cheap every frame: it only rebuilds when
    // the camera has crossed a 400 m tile boundary.
    prof.cpuBegin("pavement");
    pavement?.update(camera.position.x, camera.position.z);
    prof.cpuEnd("pavement");

    // The street fields follow the same 400 m tiles, and each of them holds a
    // ring of its own size around the camera; see render/traffic.ts for why the
    // moving cars reach four times further than the parked ones.
    prof.cpuBegin("lamps");
    lamps?.update(camera.position.x, camera.position.z);
    prof.cpuEnd("lamps");
    prof.cpuBegin("parked");
    parkedCars?.update(camera.position.x, camera.position.z);
    prof.cpuEnd("parked");
    prof.cpuBegin("bridges");
    bridges?.update(camera, renderer.getDrawingBufferSize(bridgeBufferSize).y, elapsed);
    prof.cpuEnd("bridges");
    // The player's headlights and the lamps' light on the ground; see
    // render/streetlight.ts. `?noheadlights=1` and `?nolamplight=1` switch
    // each off, which is how tools/verify-night.ts proves its floor bites.
    {
      const sl = streetLightUniforms;
      sl.uLampGridOrigin.value.w = lampLightOff ? 0 : light.night;
      const hp = sl.uHeadParams.value;
      const on = carActive && car && !headlightsOff ? THREE.MathUtils.smoothstep(light.night, 0.02, 0.3) : 0;
      hp.x = on;
      if (on > 0 && car) {
        const h = car.headingDeg * DEG2RAD;
        const fx = Math.sin(h), fz = -Math.cos(h);
        sl.uHeadFwd.value.set(fx, 0, fz);
        sl.uHeadPos.value.set(car.position.x + fx * 2.2, car.position.y + 0.65, car.position.z + fz * 2.2);
        // Automatic high beam, as most new cars have: full beam unless a
        // car is ahead in either direction within 150 m and a lane or two.
        const lead = traffic?.sim.ahead(car.position.x, car.position.z, fx, fz, 5, 150) ?? null;
        hp.y = forceHighBeam ? 1 : lead ? 0 : 1;
      }
    }
    // Radians per pixel, for the lamps' footprint: a lens hands its light to a
    // stable point once it is under a couple of pixels (render/glowpoints.ts).
    const pixAngle = pixelAngle(camera.fov, renderer.getDrawingBufferSize(bridgeBufferSize).y);
    for (const g of [lamps?.glow, traffic?.glow]) {
      if (!g) continue;
      g.uniforms.uCameraPos.value.copy(camera.position);
      g.uniforms.uPixelAngle.value = pixAngle;
      g.uniforms.uNight.value = light.night;
    }
    for (const u of streetUniformSets) {
      // The bridges share this set and carry no lamp, hence the guard.
      if (u.uPixelAngle) u.uPixelAngle.value = pixAngle;
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
    // THE HOUR OF THE DAY, on the traffic: how much of the placed peak is out
    // and how fast it goes, per road class. The sim steps on the delta of
    // `elapsed`, which `?shot` holds at zero, so a pinned pose photographs the
    // field exactly as it was placed and two runs of one URL agree.
    //
    // `now` and not a fresh sceneNow(): the same instant the sun was placed at
    // this frame, so a scrubbed 08:00 has both the light and the rush hour of
    // 08:00.
    const dEl = elapsed - lastElapsed;
    lastElapsed = elapsed;
    const ts = trafficState(now, trafficUtcOffset, wx);
    trafficNow = ts;
    if (traffic) {
      traffic.sim.player = carActive && car ? car.obstacle() : null;
      // The player's own car, drawn in the chase view; from the driver's seat
      // the dash silhouette stands in for it (see `dash`).
      traffic.player = carActive && car && carChase() ? {
        x: car.position.x, y: car.position.y, z: car.position.z,
        headingDeg: car.headingDeg, braking: car.speed > 0.5 && car.lastAccel < -2,
      } : null;
      prof.cpuBegin("traffic");
      traffic.update(camera.position.x, camera.position.z, dEl, ts);
      prof.cpuEnd("traffic");
    }

    for (const fol of canopies) {
      // Rebuilt only when the camera has moved far enough for an instance's
      // level of detail to be stale; see render/trees.ts.
      prof.cpuBegin("foliage");
      fol.update(camera.position.x, camera.position.z);
      prof.cpuEnd("foliage");
      fol.setWind(wx.windSpeed, wx.windDir);
      const f = fol.uniforms;
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
    // The quality ladder's features, read every frame because they are three
    // assignments and a step can land on any frame.
    {
      const f = quality.features;
      waterHistory.enabled = ssrBase && f.ssr;
      ao.enabled = aoBase && f.ao;
      composite.lowClouds = f.lowClouds;
    }
    // `?off=` hides whole groups for every pass of this frame; restored below.
    if (perfOff.size) {
      perfHidden.length = 0;
      for (const c of scene.children) {
        if (c.visible && perfOff.has(c.name)) { c.visible = false; perfHidden.push(c); }
      }
    }
    prof.cpuBegin("skyprobe");
    prof.begin("skyprobe");
    if (!perfOff.has("skyprobe")) skyProbe.update(renderer, light, camAlt);
    prof.end();
    prof.cpuEnd("skyprobe");
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
      ...(foliage && !perfOff.has("foliage") ? [foliage.depthScene] : []),
      ...(shrubs && !perfOff.has("shrubs") ? [shrubs.depthScene] : []),
      ...(traffic && !perfOff.has("traffic") ? [traffic.depthScene] : []),
      ...(parkedCars && !perfOff.has("parkedcars") ? [parkedCars.depthScene] : []),
    ];
    // The AO prepass needs the SAME list. Anything whose vertex shader places
    // it, and which is therefore absent from this buffer, does not merely fail
    // to occlude its neighbours: its own fragments read the sky occlusion of
    // whatever is BEHIND it. A car in a street canyon then shades against the
    // pavement under the far kerb and comes out black, which is exactly what it
    // did until this line stopped being a shorter list than the one above it.
    prof.cpuBegin("sunshadow");
    prof.begin("sunshadow");
    if (!perfOff.has("shadow")) sunShadow.update(renderer, scene, camera, light.sunDir, quality.features.lowShadows ? 0.7 : 1, shadowCasters);
    prof.end();
    prof.cpuEnd("sunshadow");
    // The environment probe renders the city into a cube with its own camera
    // and its own viewport, where a gl_FragCoord lookup into a buffer built for
    // the main frame would be reading the wrong pixel of the wrong picture.
    // Off for that pass, back on for this one.
    setAo(0);
    // The drone samples the same environment probe this pass renders into,
    // so it must not be in the scene while the probe is drawn (Chrome logged
    // a framebuffer feedback loop every frame).
    // The live traffic samples it too.
    const droneShown = droneModel.group.visible;
    const trafficShown = airTraffic.render.group.visible;
    const transitShown = transit.render?.group.visible ?? false;
    droneModel.group.visible = false;
    airTraffic.render.group.visible = false;
    if (transit.render) transit.render.group.visible = false;
    // Street detail is left out of the aircraft's cube too: a car or a lamp is
    // a pixel or two of a 128 px face, behind a roughness blur, and each group
    // is a full instanced draw per face.
    probeHidden.length = 0;
    for (const g of [lamps?.group, traffic?.group, parkedCars?.group, shrubs?.group, pavement?.group]) {
      if (g && g.visible) { g.visible = false; probeHidden.push(g); }
    }
    prof.cpuBegin("aircraft");
    prof.begin("aircraft");
    if (!perfOff.has("aircraft")) model.prepare(renderer, scene, quality.features.lowShadows ? 0.7 : 1, (c) => sky.syncCamera(c), camera.position);
    prof.end();
    prof.cpuEnd("aircraft");
    for (const g of probeHidden) g.visible = true;
    droneModel.group.visible = droneShown;
    airTraffic.render.group.visible = trafficShown;
    if (transit.render) transit.render.group.visible = transitShown;
    sky.syncCamera(camera);
    prof.cpuBegin("ao");
    prof.begin("ao");
    if (!perfOff.has("ao")) ao.render(renderer, scene, camera, shadowCasters);
    prof.end();
    prof.cpuEnd("ao");
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
    {
      // One slider, three machines: the aeroplane's throttle, or the car's
      // and the drone's cruise speed, which is what lets a phone thumb do
      // nothing but steer in them.
      const ground = droneActive || carActive;
      const lever = throttleSlider.take();
      if (lever !== null) {
        if (ground) input.groundLever = lever;
        else ac.throttle = lever;
      }
      const groundSpeed = carActive && car ? car.speed : drone.speed;
      throttleSlider.update(
        ground ? input.groundLever : ac.throttle,
        ground ? groundSpeed : ac.airspeed,
        !shotMode,
        ground,
      );
      modeBar.update(carActive ? "car" : droneActive ? "drone" : "plane", !shotMode);
    }
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
    prof.cpuBegin("scene");
    prof.begin("scene");
    renderer.render(scene, camera);
    prof.end();
    prof.cpuEnd("scene");
    // What this frame drew is what the next frame's water reflects.
    prof.cpuBegin("waterhist");
    prof.begin("waterhist");
    if (!perfOff.has("ssr")) waterHistory.capture(renderer, target, camera);
    prof.end();
    prof.cpuEnd("waterhist");

    // Pass 2 + 3: clouds raymarched at half resolution against that target's
    // depth, then a full-resolution present that folds them in and tone maps.
    composite.update(camera, wx, light, elapsed, skyProbe.sh);
    composite.presentUniforms.uExposure.value = light.exposure * exposureScale;
    composite.presentUniforms.uNight.value = light.night;
    composite.brightUniforms.uExposure.value = light.exposure * exposureScale;
    composite.brightUniforms.uNight.value = light.night;
    prof.cpuBegin("composite");
    prof.begin("composite");
    composite.render(renderer, target.texture, target.depthTexture);
    prof.end();
    prof.cpuEnd("composite");
    for (const c of perfHidden) c.visible = true;
    // `?perfsync`: drain the GPU every frame, so a frame costs CPU plus GPU
    // with no overlap. Kept as an experiment, not the default: drained, the
    // M4 GPU idles while the CPU works and settles into a slow clock state for
    // seconds at a time (see tools/profile.ts), which no statistic undoes.
    if (perfSync) {
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, perfSyncPixel);
    }
    perfHidden.length = 0;

    prof.cpuEnd("frame");
    prof.frameEnd();
    if (timedFrames < frameRing.length) frameRing[timedFrames++] = rawDt * 1000;
    shotFrames++;

    smoothedMs += (dt * 1000 - smoothedMs) * 0.06;
    if (quality.update(smoothedMs, dt, rawDt * 1000)) {
      quality.apply(renderer);
      // Multisampling is a property of the target's buffers, so a change
      // re-creates them; three allocates afresh on the next render into it.
      const samples = quality.features.msaa ? budget.msaaSamples : 0;
      if (target.samples !== samples) {
        target.samples = samples;
        target.dispose();
      }
      const w = canvas.clientWidth || innerWidth;
      const h = canvas.clientHeight || innerHeight;
      renderer.setSize(w, h, false);
      resizeTargets();
      const f = quality.features;
      console.log(
        `[flyby] quality step ${quality.level}: scale ${quality.scale.toFixed(2)}, ` +
        `ssr ${f.ssr ? "on" : "off"}, clouds ${f.lowClouds ? "low" : "full"}, ao ${f.ao ? "on" : "off"}, ` +
        `shadows ${f.lowShadows ? "low" : "full"} (${smoothedMs.toFixed(1)} ms)`,
      );
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
  };

  // `?perfbench=K`: every animation frame draws K frames back to back and
  // drains the GPU once at the end, and the frame cost recorded is the batch's
  // wall time over K. tools/profile.ts measures with this because both other
  // ways failed on this machine. Uncapped, Chrome sometimes paces a page at
  // exactly half rate: the same build of manhattan-cruise read 29.7 ms on one
  // load and 58.9 on the next. Drained every frame, the M4's GPU idles while
  // the CPU works and drops to a slow clock for seconds at a time. A batch
  // keeps the GPU busy, overlaps CPU and GPU the way a real frame loop does,
  // and is one task, so nothing paces it.
  const benchK = Math.max(0, Math.floor(Number(new URLSearchParams(location.search).get("perfbench") ?? 0)));
  if (benchK > 0) {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    renderer.setAnimationLoop(() => {
      const t0 = performance.now();
      for (let k = 0; k < benchK; k++) frameBody();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const ms = (performance.now() - t0) / benchK;
      if (benchTimed < benchRing.length) benchRing[benchTimed++] = ms;
    });
  } else {
    renderer.setAnimationLoop(frameBody);
  }

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
      /**
       * The lane gate's measurement, from the SIM rather than from pixels:
       * step the street traffic `seconds` at a fixed 1/30 s (the shot clock is
       * held, so nothing else moves), then measure every car within `radiusM`
       * of the camera against its centreline, and the player's car against
       * its own lane. `biasM` displaces every car sideways first, which is how
       * tools/verify-night.ts proves the bound can fail.
       */
      /** What the street traffic costs on the CPU: one sim step and the whole
       *  per-frame update (step, poses, upload), in ms, timed over `frames`
       *  steps of 1/60 s so a held shot clock still measures something. */
      streetTrafficCost(frames = 120) {
        if (!traffic) return null;
        let step = 0, update = 0;
        for (let i = 0; i < frames; i++) {
          traffic.update(camera.position.x, camera.position.z, 1 / 60, trafficNow);
          step += traffic.sim.stats.lastStepMs;
          update += traffic.stats.lastBuildMs;
        }
        return { cars: traffic.sim.cars.length, stepMs: step / frames, updateMs: update / frames };
      },
      streetLanes(seconds = 20, radiusM = 200, biasM = 0) {
        if (!traffic || !roadGraph) return null;
        traffic.sim.player = carActive && car ? car.obstacle() : null;
        for (let i = 0; i < Math.round(seconds * 30); i++) traffic.sim.step(1 / 30);
        const r = measureLanes(traffic.sim, roadGraph, camera.position.x, camera.position.z, radiusM, biasM);
        let playerLaneErrM: number | null = null;
        let overlapsPlayer = 0;
        const tr = car?.track;
        if (carActive && car && tr) {
          const e = roadGraph.edges[tr.half.edge];
          playerLaneErrM = Math.abs(car.lateralM + biasM - laneOffsetM(e, tr.half.forward));
          const o = car.obstacle()!;
          for (const c of traffic.sim.cars) {
            const p = traffic.sim.pose(c, { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0 });
            const rx = p.x - o.x, rz = p.z - o.z;
            if (Math.abs(rx * o.dirX + rz * o.dirZ) < 4.6 && Math.abs(-rx * o.dirZ + rz * o.dirX) < 1.8) overlapsPlayer++;
          }
        }
        return { ...r, playerLaneErrM, overlapsPlayer };
      },
      // What the live-traffic layer has and draws, for the traffic checks.
      get traffic() {
        return {
          tracks: airTraffic.traffic.tracks.size,
          polls: airTraffic.polls,
          error: airTraffic.lastError,
          ...airTraffic.render.stats,
          tags: airTraffic.tags.root.querySelectorAll(".ttag:not([style*='display: none'])").length,
        };
      },
      // What the transit layer has and draws, for the transit shots.
      get transit() {
        return transit.stats;
      },
      transitList: () => transit.list(),
      /** Every track as lat/lon/AMSL, for pointing a pose at a real aircraft. */
      trafficList: () =>
        [...airTraffic.traffic.tracks.values()].map((t) => ({
          ...origin.toLatLon(t.pose.x, t.pose.z),
          y: t.pose.y,
          hdg: t.pose.headingDeg,
          flight: t.info.flight,
          type: t.info.type,
          ground: t.k.ground,
        })),
      capture: () => canvas.toDataURL("image/png"),
      // What the aeroplane is doing, for a harness that drives the controls
      // and has to say what came of it. On a phone in clean view no
      // instrument on the page shows bank or vertical speed.
      get flight() {
        return {
          rollDeg: ac.rollDeg,
          verticalSpeed: ac.verticalSpeed,
          bankCommandDeg: easyStick.bankCommandDeg,
          easyEngaged: easyStick.engaged,
          altitude: ac.position.y,
        };
      },
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
      resetTiming: () => { timedFrames = 0; benchTimed = 0; },
      /** `?perfbench` batch costs, ms per frame, since resetTiming. */
      benchTrace: () => Array.from(benchRing.slice(0, benchTimed)),
      /** Per-pass GPU and per-subsystem CPU means; see render/gpuprof.ts. */
      profile: () => prof.report(),
      resetProfile: () => prof.reset(),
      setOff: (names: string[]) => {
        perfOff.clear();
        for (const n of names) perfOff.add(n);
        composite.skip = perfOff;
      },
      // Moves the clouds' clock only, so tools/verify-clouds.ts can ask what
      // one frame of cloud time does to a frame whose scene is otherwise still.
      stepClouds: (s: number) => { composite.timeOffset += s; },
      get timed() { return timedFrames; },
      frameTrace: () => Array.from(frameRing.slice(0, timedFrames)),
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
          (buildings ? buildings.stats.triangles + Math.max(0, buildings.detailTriangles) : 0) +
          (foliage ? foliage.stats.triangles : 0) +
          (shrubs ? shrubs.stats.triangles : 0) +
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
      get shrubs() { return shrubs ? shrubs.stats.count : 0; },
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
      sunShadow, drone, skyProbe, ao, car, detailRing, bridgeDecks, roadPack, roadGraph,
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
