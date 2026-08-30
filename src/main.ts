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
import { Terrain, cityRingsForDevice } from "./render/terrain";
import { computeLighting } from "./render/lighting";
import { loadHeightfield, bboxAround, type Heightfield } from "./data/dem";
import { stitchImagery, type StitchedImage } from "./data/imagery";
import { fetchWeather, fetchForecast, beamOpacity, type Weather } from "./data/weather";
import { solarState, sceneTime } from "./data/solar";
import { Origin } from "./geo";
import { CITIES, cityById, cityAt, DEFAULT_CITY, type City } from "./cities";
import { Hud, LoadingScreen } from "./app/hud";
import { showMenu } from "./app/menu";
import { Aircraft, DEFAULT_CONFIG, EASY_CONFIG, chooseStartAltitude } from "./sim/aircraft";
import { ChaseCam, CAMERA_MODES } from "./sim/chasecam";
import { Drone, DRONE_RADIUS } from "./sim/drone";
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
import { Roads } from "./render/roads";
import { buildLandMask, emptyLandMask, type LandMask } from "./render/landmask";
import { Composite } from "./render/composite";
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

  const out: Weather = { ...observed, source: "simulated" };
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
  const rings = cityRingsForDevice();
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    drapes.push(await stitchImagery(bboxAround(city.lat, city.lon, ring.extent * 1.05), ring.imageryZoom));
    loading.set(0.44 + 0.4 * (++imgDone / rings.length), "loading imagery");
  }

  loading.set(0.88, "building world");
  const { renderer, scene, camera } = createRenderer(canvas);
  const composite = new Composite(renderer);
  const target = createSceneTarget(renderer);
  const quality = new AdaptiveQuality(renderer);

  const resizeTargets = () => {
    const s2 = renderer.getDrawingBufferSize(new THREE.Vector2());
    target.setSize(s2.x, s2.y);
    composite.resize(renderer);
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
  const sunShadow = new SunShadow();
  // One environment probe for the whole scene: sky irradiance for every diffuse
  // surface and a prefiltered cube for the glass and the wet tarmac.
  const skyProbe = new SkyProbe();
  if (new URLSearchParams(location.search).get("shadows") === "0") sunShadow.enabled = false;

  const terrain = new Terrain(origin, fields, drapes, sunShadow.uniforms);
  scene.add(terrain.group);

  // Buildings. A city with no baked pack still flies, it just has no skyline,
  // so this must never be able to fail the load.
  loading.set(0.92, "loading buildings");
  // Alongside the buildings, not after them: both are single files off the same
  // origin, so overlapping the two fetches costs nothing and saves a round trip.
  const landPromise = loadLandPack(city.id);
  const roadPromise = loadRoadPack(city.id);
  const pack = await loadCityPack(city.id);
  let buildings: Buildings | null = null;
  // The rooftops as a height field, so the aeroplane has a floor over a city
  // rather than only over the ground under it.
  const skyline = new Skyline(pack, terrain.heightAt);
  if (pack) {
    buildings = new Buildings(pack, terrain.heightAt, sunShadow.uniforms);
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
    roads = new Roads(roadPack, terrain.heightAt, sunShadow.uniforms);
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

  const observed: Weather = await wxPromise;
  const timeline = await forecastPromise;
  const timezone = timeline?.timezone ?? "UTC";
  const wallClock = new LocalClock(timezone);
  const pinned = wxOverride(observed);
  let wx: Weather = pinned ?? observed;

  const hud = new Hud(ui);
  hud.setWeather(wx, 0);

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
  // Field of view, eased. An FPV camera is wide -- most of the reason a drone
  // shot looks like a drone shot is the lens, not the flying -- but a cut from
  // 62 to 78 degrees reads as the world lurching, so it is a move, not a cut.
  const PLANE_FOV = camera.fov;
  const DRONE_FOV = 78;

  const model = new AircraftModel();
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
  const places = new Places(
    ui,
    (p) => {
      autopilot.engage({ name: p.name, x: p.x, z: p.z });
      places.setActive(p.name);
      places.setNote("");
    },
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
          autopilot.engage({ name: row.name, x: row.x, z: row.z });
          places.setActive(row.name);
          places.setNote("");
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

  // Frames drawn since the loop started, and their raw costs. The harness waits
  // on the count (a first frame still has shaders compiling and textures
  // uploading in it) and reads the ring for the frame-cost number.
  let shotFrames = 0;
  let timedFrames = 0;
  const frameRing = new Float64Array(600);

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    // The animation clock stays at zero for a screenshot. It drives the cloud
    // drift, the sky and the beacon, and a wall-clock-derived phase is the one
    // thing that would make two runs of the same URL differ.
    if (!shotMode) elapsed += dt;

    // --- Which machine is flying ------------------------------------------
    if (input.droneToggled > 0) {
      input.droneToggled = 0;
      droneActive = !droneActive;
      if (droneActive) {
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
    if (!input.paused && !droneActive) ac.update(axes, dt, groundUnderAc);

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
    if (droneActive) {
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

    // Ease the lens. ~0.4 s to settle, and the projection matrix is rebuilt
    // only while it is actually moving.
    const wantFov = droneActive ? DRONE_FOV : PLANE_FOV;
    if (Math.abs(camera.fov - wantFov) > 0.01) {
      camera.fov += (wantFov - camera.fov) * (1 - Math.pow(0.0006, dt));
      if (Math.abs(camera.fov - wantFov) <= 0.01) camera.fov = wantFov;
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
      !shotCam && (droneActive || (chase.mode !== "cockpit" && chase.cockpitBlend < 0.45));
    // Zeroed control surfaces while droning. W and A are the drone's now, and
    // a parked aeroplane waggling its ailerons at them looks haunted.
    model.update(dt, ac.throttle, droneActive ? 0 : axes.roll, ac.pitchDeg, droneActive ? 0 : axes.yaw);

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

    if (buildings) {
      const b = buildings.uniforms;
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
      // Local SOLAR hour, from UTC and the longitude, rather than the civil
      // hour: it needs no timezone database, it is what the sun is actually
      // doing, and the lights coming on want to track the evening rather than
      // a political line on a map.
      const localHour =
        (now.getUTCHours() + now.getUTCMinutes() / 60 + city.lon / 15 + 24) % 24;
      const hf = hourFactors(localHour);
      b.uHourFactor.value.set(hf.residential, hf.office, hf.other);
    }

    if (roads) {
      const r = roads.uniforms;
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

    const p = model.uniforms;
    p.uSunDir.value.copy(light.sunDir);
    p.uSunColor.value.copy(light.sunColor);
    p.uSunIntensity.value = light.sunIntensity;
    p.uMoonDir.value.copy(light.moonDir);
    p.uMoonLight.value.copy(light.moonLight);
    p.uAmbient.value.copy(light.ambient);
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
    sunShadow.update(renderer, scene, camera, light.sunDir, quality.scale);
    model.prepare(renderer, scene, quality.scale, (c) => sky.syncCamera(c));
    sky.syncCamera(camera);

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
    if (droneActive) {
      minimap.update(drone.position.x, drone.position.z, drone.yawDeg, elapsed);
    } else {
      minimap.update(ac.position.x, ac.position.z, ac.headingDeg, elapsed);
    }

    osd.setDrone(
      droneActive
        ? { speedMs: drone.speed, aglM: drone.position.y - groundUnderDrone }
        : null,
    );
    if (!droneActive) {
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

    if (timedFrames < frameRing.length) frameRing[timedFrames++] = dt * 1000;
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
      hud.setPlace(city, wallClock.parts(now).time, wallClock.abbrev(now));
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
      // Median, not mean: one 200 ms hitch from a texture upload or a GC would
      // dominate a mean over a few hundred frames and say nothing about the
      // cost of a frame.
      frameMs: () => {
        const s = Array.from(frameRing.slice(0, timedFrames)).sort((a, b) => a - b);
        return s.length ? s[s.length >> 1] : 0;
      },
      get triangles() { return buildings ? buildings.stats.triangles : 0; },
      get lod() { return buildings ? buildings.stats.lod : 0; },
    },
    flyby: {
      scene, camera, renderer, terrain, sky, city, tune, buildings, roads, composite, ac, chase,
      sunShadow, drone, skyProbe,
      get droneActive() { return droneActive; },
      get wx() { return wx; },
      get time() { return now; },
      setOffsetHours: (h: number) => timebar.setOffset(h * 3600),
      setExposure: (v: number) => (exposureScale = v),
    },
  });

  // A developer's instrument, on the same switch as the frame counter: it costs
  // a GPU stall to answer and nothing on the page should pay that unasked.
  if (showPerf) {
    Object.assign(window as unknown as Record<string, unknown>, {
      __cloudMetric: () => composite.measureBanding(renderer),
    });
  }
}

main().catch((err) => {
  console.error(err);
  const d = document.getElementById("loading");
  if (d) d.querySelector(".step")!.textContent = `failed: ${err.message}`;
});
