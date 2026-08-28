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
import { Terrain, CITY_RINGS } from "./render/terrain";
import { computeLighting } from "./render/lighting";
import { loadHeightfield, bboxAround, type Heightfield } from "./data/dem";
import { stitchImagery, type StitchedImage } from "./data/imagery";
import { fetchWeather, fetchForecast, type Weather } from "./data/weather";
import { solarState, sceneTime } from "./data/solar";
import { Origin } from "./geo";
import { CITIES, cityById, cityAt, DEFAULT_CITY, type City } from "./cities";
import { Hud, LoadingScreen } from "./app/hud";
import { showMenu } from "./app/menu";
import { Aircraft, DEFAULT_CONFIG, EASY_CONFIG, chooseStartAltitude } from "./sim/aircraft";
import { ChaseCam, CAMERA_MODES } from "./sim/chasecam";
import { Input } from "./sim/input";
import { AircraftModel } from "./render/aircraftmodel";
import { Osd } from "./app/osd";
import { Timebar, LocalClock } from "./app/timebar";
import { Tour, Beacon } from "./sim/tour";
import { loadCityPack } from "./data/citypack-load";
import { Buildings } from "./render/buildings";
import { buildUrbanMask, emptyUrbanMask, type UrbanMask } from "./render/urbanmask";
import { Composite } from "./render/composite";

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
  for (let r = 0; r < CITY_RINGS.length; r++) {
    const ring = CITY_RINGS[r];
    drapes.push(await stitchImagery(bboxAround(city.lat, city.lon, ring.extent * 1.05), ring.imageryZoom));
    loading.set(0.44 + 0.4 * (++imgDone / CITY_RINGS.length), "loading imagery");
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

  const sky = new Sky();
  scene.add(sky.mesh);

  const terrain = new Terrain(origin, fields, drapes);
  scene.add(terrain.group);

  // Buildings. A city with no baked pack still flies, it just has no skyline,
  // so this must never be able to fail the load.
  loading.set(0.92, "loading buildings");
  const pack = await loadCityPack(city.id);
  let buildings: Buildings | null = null;
  if (pack) {
    buildings = new Buildings(pack, terrain.heightAt);
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

  // Where the city actually is, for night lighting. A place with no pack gets
  // an all-dark mask: unlit open country is a more honest answer than guessing
  // from the daylight imagery and lighting up the whole map.
  const urban: UrbanMask = pack ? buildUrbanMask(pack) : emptyUrbanMask();
  for (const u of terrain.uniforms) {
    u.uUrban.value = urban.texture;
    u.uUrbanExtent.value = urban.extent;
  }

  const observed: Weather = await wxPromise;
  const timeline = await forecastPromise;
  const timezone = timeline?.timezone ?? "UTC";
  const wallClock = new LocalClock(timezone);
  let wx: Weather = observed;

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
  const startGround = terrain.heightAt(startX, startZ);
  ac.reset(
    startX,
    chooseStartAltitude(city.startAlt, Math.max(startGround, groundAtCentre), wx.low),
    startZ,
    startHdg,
  );

  const tour = new Tour(city, origin, terrain.heightAt);
  const beacon = new Beacon();
  scene.add(beacon.group);

  const chase = new ChaseCam();
  const input = new Input(canvas, ui);
  const model = new AircraftModel();
  scene.add(model.group);

  const osd = new Osd(ui);
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

  hud.showControls();
  loading.done();

  // Live tuning scale, driven from the console while looking at the scene.
  let exposureScale = 1;

  // Frame timing, smoothed. A raw per-frame number is unreadable.
  let smoothedMs = 16;
  // Starts past the threshold so the first frame fills the panels. Starting at
  // zero left the place name, the clock and the route blank for the first four
  // tenths of a second, which is exactly when someone is looking at them.
  let perfAccum = 1;

  // Weather is resampled on a timer, not per frame: `timeline.at` allocates a
  // Weather, and doing that 60 times a second to answer a question whose answer
  // changes on an hourly grid is pure garbage.
  let wxAccum = 0;
  let wxDirty = false;

  const clock = new THREE.Clock();
  let elapsed = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    elapsed += dt;

    const axes = input.sample(dt);

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
      const next = Math.abs(clockOffset) < 900 ? observed : timeline.at(now);
      if (next !== wx) {
        wx = next;
        wxDirty = false;
      }
    }

    const groundUnderAc = terrain.heightAt(ac.position.x, ac.position.z);
    ac.setWeather(wx, ac.position.y);
    if (!input.paused) ac.update(axes, dt, groundUnderAc);

    chase.mode = CAMERA_MODES[input.cameraCycled % CAMERA_MODES.length];
    chase.update(camera, ac, dt, input.lookBack, terrain.heightAt(camera.position.x, camera.position.z));
    camera.updateMatrixWorld();

    model.group.position.copy(ac.position);
    model.group.quaternion.copy(ac.quaternion);
    // In the cockpit view the camera is INSIDE the aeroplane, so drawing it
    // fills the frame with the back of its own instrument panel.
    model.group.visible = chase.mode !== "cockpit";
    model.update(dt, ac.throttle, axes.roll, ac.pitchDeg);

    if (!input.paused) tour.update(ac.position, dt);
    const tourDist = tour.distanceTo(ac.position);
    beacon.update(tour.active, elapsed, tourDist);
    if (tour.justCollected) hud.flashLandmark(tour.justCollected.name);

    const solar = solarState(now, city.lat, city.lon);
    const light = computeLighting(solar, wx);

    const camAlt = camera.position.y;
    sky.update(solar, wx, camAlt, elapsed);
    sky.syncCamera(camera);

    for (const u of terrain.uniforms) {
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
      b.uSunDir.value.copy(light.sunDir);
      b.uSunColor.value.copy(light.sunColor);
      b.uSunIntensity.value = light.sunIntensity;
      b.uAmbient.value.copy(light.ambient);
      b.uNight.value = light.night;
      b.uNightGlow.value.copy(light.nightGlow);
      b.uMoonDir.value.copy(light.moonDir);
      b.uMoonLight.value.copy(light.moonLight);
      b.uWetness.value = light.wetness;
      b.uMieG.value = light.mieG;
      b.uTurbidity.value = light.turbidity;
      b.uCamAltitude.value = camAlt;
      b.uExposure.value = light.exposure * exposureScale;
    }

    const p = model.uniforms;
    p.uSunDir.value.copy(light.sunDir);
    p.uSunColor.value.copy(light.sunColor);
    p.uSunIntensity.value = light.sunIntensity;
    p.uMoonDir.value.copy(light.moonDir);
    p.uMoonLight.value.copy(light.moonLight);
    p.uAmbient.value.copy(light.ambient);

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

    // Pass 1: the world, in linear HDR, into the offscreen target.
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);

    // Pass 2 + 3: clouds raymarched at half resolution against that target's
    // depth, then a full-resolution present that folds them in and tone maps.
    composite.update(camera, wx, light, elapsed);
    composite.uniforms.uSunSurfaceCloud.value = 0.105;
    composite.presentUniforms.uExposure.value = light.exposure * exposureScale;
    composite.render(renderer, target.texture, target.depthTexture);

    smoothedMs += (dt * 1000 - smoothedMs) * 0.06;
    if (quality.update(smoothedMs, dt)) {
      quality.apply(renderer);
      const w = canvas.clientWidth || innerWidth;
      const h = canvas.clientHeight || innerHeight;
      renderer.setSize(w, h, false);
      resizeTargets();
      console.log(`[flyby] render scale -> ${quality.scale.toFixed(2)} (${smoothedMs.toFixed(1)} ms)`);
    }
    perfAccum += dt;
    if (perfAccum > 0.4) {
      perfAccum = 0;
      hud.setPerf(1000 / smoothedMs, smoothedMs, buildings ? buildings.stats.triangles : 0, quality.scale);
      hud.setTour(tour.marks, tourDist, tour.finished);
      hud.setWeather(wx, clockOffset);
      hud.setPlace(city, wallClock.parts(now).time, wallClock.abbrev(now));
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
    ];
    let hit = 0;
    for (const set of sets) if (name in set) { set[name].value = value; hit++; }
    return `${name} = ${value} (${hit} materials)`;
  };

  Object.assign(window as unknown as Record<string, unknown>, {
    flyby: {
      scene, camera, renderer, terrain, sky, city, tune, buildings, composite, ac, chase,
      get wx() { return wx; },
      get time() { return now; },
      setOffsetHours: (h: number) => timebar.setOffset(h * 3600),
      setExposure: (v: number) => (exposureScale = v),
    },
  });
}

main().catch((err) => {
  console.error(err);
  const d = document.getElementById("loading");
  if (d) d.querySelector(".step")!.textContent = `failed: ${err.message}`;
});
