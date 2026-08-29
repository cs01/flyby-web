// The gate on the solid city.
//
// Collision is the one part of this project where the difference between right
// and catastrophically wrong is invisible in a screenshot. A drone stuck to a
// wall and a drone skimming it look identical in a still; a broadphase that
// quietly degraded into a linear scan over 187,000 footprints looks identical
// until you watch the frame time; a roof that is solid only some of the time
// looks like a roof.
//
// So this runs against the REAL Manhattan pack and the REAL CityCollision, not
// a hand-made box. 187k footprints is the input that has degenerate rings,
// zero-length edges, L-shaped plans whose centroid is outside them, and one
// 876 m pier -- none of which a synthetic test would ever produce.
//
// The terrain under it SLOPES. That is not decoration: a collider that used
// one global ground height passes every check here on flat ground and fails
// "lands on the roof" and "roofs are only solid from above" the moment it does
// not, and San Francisco is nothing but slope.
//
// Every bound below has been watched to FAIL, by perturbing the thing it
// guards. A check nobody has seen fail is not a check.

import * as THREE from "three";
import { parseCityPack, footprintGroundY, type Building } from "../src/data/citypack";
import {
  CityCollision, MIN_HEIGHT_M, MIN_THICKNESS_M, SLAB_MAX_HEIGHT_M, SLAB_MIN_AREA_M2,
  ringArea, ringPerimeter,
} from "../src/sim/citycollision";
import { Drone, DRONE_RADIUS, type DroneInput } from "../src/sim/drone";

const R = DRONE_RADIUS;
const DT = 1 / 60;

/**
 * A 1% slope in x and 0.6% in z: over the pack's 16 km that is 160 m of relief,
 * which is more than Manhattan has and about what San Francisco has.
 */
const heightAt = (x: number, z: number): number => 8 + x * 0.01 - z * 0.006;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

const NEUTRAL: DroneInput = {
  forward: 0, strafe: 0, lift: 0, yaw: 0, pitch: 0,
  boost: 0, lookYawDeg: 0, lookPitchDeg: 0,
};

/**
 * Point in ring, written out again here rather than borrowed from the module
 * under test. An oracle that calls the implementation's own inside test agrees
 * with it by construction and can never catch it being wrong.
 */
function pointInRing(ring: Float32Array, px: number, pz: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1];
    const xj = ring[j * 2], zj = ring[j * 2 + 1];
    if ((zi > pz) !== (zj > pz) && px < xi + ((pz - zi) / (zj - zi)) * (xj - xi)) inside = !inside;
  }
  return inside;
}

function topYOf(b: Building): number {
  return footprintGroundY(b, heightAt) + b.topM;
}

/** Heading in the drone's convention: forward at yaw 0 is -z. */
function headingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return (Math.atan2(toX - fromX, -(toZ - fromZ)) * 180) / Math.PI;
}

function forwardVec(yawDeg: number): { x: number; z: number } {
  const r = (yawDeg * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

// ---------------------------------------------------------------------------

const pack = parseCityPack(await Bun.file("public/cities/manhattan.city").arrayBuffer());

// --- 1. Build cost ---------------------------------------------------------
const t0 = performance.now();
const col = new CityCollision(pack, heightAt);
const buildMs = performance.now() - t0;
check(
  "index builds in under 2 s",
  buildMs < 2000,
  `${buildMs.toFixed(0)} ms for ${pack.buildings.length} footprints -> ` +
  `${col.stats.buildings} indexed, ${col.stats.cells} cells, ` +
  `max ${col.stats.maxPerCell} per cell, ${(col.stats.bytes / 1048576).toFixed(1)} MB`,
);

// --- 2. Query cost ---------------------------------------------------------
// The check that catches a broadphase quietly becoming a linear scan. Nothing
// else here would: a linear scan is perfectly CORRECT, it is just 3000x slower,
// and every other assertion in this file would still pass.
{
  const N = 20000;
  const pos = new THREE.Vector3();
  const vel = new THREE.Vector3();
  let seed = 987654321;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // Positions drawn from the pack's own footprints, so the query is aimed at
  // where the buildings actually ARE. Uniform points over a 16 km square are
  // mostly water and mostly hit an empty cell, which measures nothing.
  const xs = new Float64Array(N), zs = new Float64Array(N), ys = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const b = pack.buildings[Math.floor(rnd() * pack.buildings.length)];
    xs[i] = b.cx + (rnd() - 0.5) * 40;
    zs[i] = b.cz + (rnd() - 0.5) * 40;
    ys[i] = heightAt(b.cx, b.cz) + rnd() * b.topM;
  }
  // Warm the JIT; the first few hundred calls are interpreted and would
  // dominate a 150 ms budget.
  for (let i = 0; i < 2000; i++) {
    pos.set(xs[i], ys[i], zs[i]);
    vel.set(10, 0, 10);
    col.resolve(pos, vel, R);
  }

  const q0 = performance.now();
  for (let i = 0; i < N; i++) {
    pos.set(xs[i], ys[i], zs[i]);
    vel.set(10, 0, 10);
    col.resolve(pos, vel, R);
  }
  const queryMs = performance.now() - q0;
  check(
    "20k resolves in under 150 ms",
    queryMs < 150,
    `${queryMs.toFixed(1)} ms, ${((queryMs * 1e6) / N).toFixed(0)} ns/call`,
  );
}

// --- Pick the specimens ----------------------------------------------------
// Chosen by scanning the pack rather than hardcoded by index, so a rebake does
// not silently turn this file into a test of whatever building landed at 4127.

/** Tall, with a centroid genuinely inside its own plan. */
let tower: Building | null = null;
/** Wide and flat-topped: something you can actually land a drone on. */
let helipad: Building | null = null;
/** A long straight wall to skim. */
let wall: { b: Building; x0: number; z0: number; x1: number; z1: number; len: number } | null = null;

for (const b of pack.buildings) {
  const n = b.ring.length / 2;
  if (n < 3) continue;
  const h = b.topM - b.baseM;
  if (!pointInRing(b.ring, b.cx, b.cz)) continue;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) {
    if (b.ring[i] < minX) minX = b.ring[i];
    if (b.ring[i] > maxX) maxX = b.ring[i];
    if (b.ring[i + 1] < minZ) minZ = b.ring[i + 1];
    if (b.ring[i + 1] > maxZ) maxZ = b.ring[i + 1];
  }
  const span = Math.min(maxX - minX, maxZ - minZ);

  if (h > 120 && span > 45 && (!tower || h > tower.topM - tower.baseM)) tower = b;
  if (h > 40 && span > 70 && (!helipad || span > 0)) helipad = b;

  if (h > 60) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = b.ring[i * 2], z0 = b.ring[i * 2 + 1];
      const x1 = b.ring[j * 2], z1 = b.ring[j * 2 + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len > 60 && (!wall || len > wall.len)) wall = { b, x0, z0, x1, z1, len };
    }
  }
}

if (!tower || !helipad || !wall) {
  console.log("FAIL could not find test specimens in the pack");
  process.exit(1);
}

// --- 3. Solid --------------------------------------------------------------
// 200 m of run-up at boost, then long enough pressed against the wall that a
// collider which only holds for one frame gives itself away. 3 s does not even
// reach the building from 200 m at 42 m/s, which is why this is 8.
{
  const target = tower;
  const topY = topYOf(target);
  const baseY = footprintGroundY(target, heightAt) + target.baseM;
  const midY = (baseY + topY) * 0.5;

  // Approach from the -x side, straight at the centroid.
  const startX = target.cx - 200;
  const startZ = target.cz;
  const yaw = headingTo(startX, startZ, target.cx, target.cz);

  const d = new Drone();
  d.enterFrom(new THREE.Vector3(startX, midY, startZ), yaw, new THREE.Vector3());
  d.position.set(startX, midY, startZ);
  const f = forwardVec(yaw);
  d.velocity.set(f.x * 40, 0, f.z * 40);

  let breaches = 0;
  let climbed = 0;
  let contacted = false;
  const steps = Math.round(8 / DT);
  for (let i = 0; i < steps; i++) {
    d.update({ ...NEUTRAL, forward: 1, boost: 1 }, DT, heightAt(d.position.x, d.position.z));
    col.resolve(d.position, d.velocity, R);
    if (pointInRing(target.ring, d.position.x, d.position.z) && d.position.y < topY) breaches++;
    const rose = Math.abs(d.position.y - midY);
    if (rose > climbed) climbed = rose;
    if (Math.hypot(d.position.x - target.cx, d.position.z - target.cz) < 120) contacted = true;
  }
  const stoppedShort = Math.hypot(d.position.x - target.cx, d.position.z - target.cz);
  // The altitude clause is not decoration. Without it a collider that answers
  // every contact by pushing the drone straight UP passes this check by
  // teleporting it over the roof, and "never inside the footprint below the
  // roof" is then true for the least useful reason imaginable.
  check(
    "a tower is solid",
    breaches === 0 && contacted && climbed < 25,
    `${breaches} steps inside the footprint below the roof, ${climbed.toFixed(1)} m of altitude wandered; ` +
    `stopped ${stoppedShort.toFixed(1)} m from the centroid of a ${(target.topM - target.baseM).toFixed(0)} m building`,
  );
}

// --- 4. Slides -------------------------------------------------------------
// The one that separates a collider from a wall of glue. Zeroing the whole
// velocity on contact passes every other check in this file.
{
  const w = wall;
  const dx = (w.x1 - w.x0) / w.len, dz = (w.z1 - w.z0) / w.len;
  const midX = (w.x0 + w.x1) * 0.5, midZ = (w.z0 + w.z1) * 0.5;
  // Which side is OUT is decided by stepping off the edge and asking, not by
  // assuming a winding. The renderer normalises ring order in its own
  // constructor, so a pack read straight off disk has both.
  let nx = dz, nz = -dx;
  if (pointInRing(w.b.ring, midX + nx * 0.5, midZ + nz * 0.5)) { nx = -nx; nz = -nz; }
  const topY = topYOf(w.b);
  const baseY = footprintGroundY(w.b, heightAt) + w.b.baseM;
  const flyY = (baseY + topY) * 0.5;

  // 45 degrees: half into the wall, half along it.
  const ax = (nx * -1 + dx) / Math.SQRT2;
  const az = (nz * -1 + dz) / Math.SQRT2;
  const yaw = headingTo(0, 0, ax, az);

  const d = new Drone();
  d.enterFrom(new THREE.Vector3(0, flyY, 0), yaw, new THREE.Vector3());
  d.position.set(midX + nx * 60 - ax * 60, flyY, midZ + nz * 60 - az * 60);
  d.velocity.set(ax * 42, 0, az * 42);

  const input: DroneInput = { ...NEUTRAL, forward: 1, boost: 1 };
  // Measured over the SECOND that follows first contact, not over the whole
  // run: the wall is only 60-odd metres long and at 40 m/s the drone is off the
  // end of it and into whatever is next door inside two seconds. What is under
  // test is the contact, not the block.
  let approach = 0;
  let contactStep = -1;
  let alongMin = Infinity;
  let alongSum = 0;
  let samples = 0;
  const steps = Math.round(6 / DT);
  for (let i = 0; i < steps; i++) {
    const before = Math.hypot(d.velocity.x, d.velocity.z);
    d.update(input, DT, heightAt(d.position.x, d.position.z));
    const preX = d.position.x, preZ = d.position.z;
    col.resolve(d.position, d.velocity, R);
    const moved = Math.hypot(d.position.x - preX, d.position.z - preZ);
    if (contactStep < 0 && moved > 1e-4) {
      contactStep = i;
      approach = before;
    }
    if (contactStep >= 0 && i - contactStep <= Math.round(1 / DT)) {
      const along = Math.abs(d.velocity.x * dx + d.velocity.z * dz);
      if (along < alongMin) alongMin = along;
      alongSum += along;
      samples++;
    }
  }
  const frac = alongMin / approach;
  check(
    "skims a facade instead of sticking",
    contactStep >= 0 && frac >= 0.6,
    `${(frac * 100).toFixed(0)}% of the ${approach.toFixed(1)} m/s approach kept along the wall ` +
    `(worst ${alongMin.toFixed(1)} m/s, mean ${(alongSum / Math.max(1, samples)).toFixed(1)} m/s ` +
    `over the second after contact, want >= 60%)`,
  );
}

// --- 5. Roofs are solid ----------------------------------------------------
// The bug this whole feature exists to kill: hovering over a roof and sinking
// through it to the street.
{
  const b = helipad;
  const topY = topYOf(b);
  const streetY = heightAt(b.cx, b.cz);

  const d = new Drone();
  d.enterFrom(new THREE.Vector3(b.cx, topY + 30, b.cz), 0, new THREE.Vector3());
  d.position.set(b.cx, topY + 30, b.cz);
  d.velocity.set(0, 0, 0);

  const steps = Math.round(5 / DT);
  for (let i = 0; i < steps; i++) {
    d.update({ ...NEUTRAL, lift: -1 }, DT, heightAt(d.position.x, d.position.z));
    col.resolve(d.position, d.velocity, R);
  }
  const want = topY + R;
  check(
    "lands on the roof, not the street",
    Math.abs(d.position.y - want) < 0.3 && d.position.y > streetY + 10,
    `y = ${d.position.y.toFixed(2)} m, roof + radius = ${want.toFixed(2)} m, ` +
    `street = ${streetY.toFixed(2)} m (${(d.position.y - streetY).toFixed(1)} m above it)`,
  );
  check(
    "settles on the roof rather than bouncing",
    Math.abs(d.velocity.y) < 1e-6,
    `vy = ${d.velocity.y.toFixed(5)} m/s`,
  );
}

// --- 6. Roofs are only solid from above ------------------------------------
// The complement, and the one that stops the fix for check 5 from turning the
// skyline into a lid. Above the roof, the city has to be free.
{
  const b = helipad;
  const topY = topYOf(b);
  // Half a metre of clearance, not five. A roof clamp with any padding on it
  // -- and padding is the first thing anyone reaches for when a drone clips a
  // parapet -- turns the skyline into a lid, and a generous flyover height
  // would never notice.
  const flyY = topY + R + 0.5;

  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < b.ring.length; i += 2) {
    if (b.ring[i] < minX) minX = b.ring[i];
    if (b.ring[i] > maxX) maxX = b.ring[i];
  }

  const startX = minX - 60;
  const yaw = headingTo(startX, b.cz, maxX + 60, b.cz);
  const d = new Drone();
  d.enterFrom(new THREE.Vector3(startX, flyY, b.cz), yaw, new THREE.Vector3());
  d.position.set(startX, flyY, b.cz);
  const f = forwardVec(yaw);
  d.velocity.set(f.x * 20, 0, f.z * 20);

  let deflected = 0;
  let crossed = false;
  const steps = Math.round(20 / DT);
  for (let i = 0; i < steps; i++) {
    d.update({ ...NEUTRAL, forward: 1 }, DT, heightAt(d.position.x, d.position.z));
    const preX = d.position.x, preY = d.position.y, preZ = d.position.z;
    col.resolve(d.position, d.velocity, R);
    const moved = Math.hypot(d.position.x - preX, d.position.y - preY, d.position.z - preZ);
    if (moved > deflected) deflected = moved;
    if (pointInRing(b.ring, d.position.x, d.position.z)) crossed = true;
    if (d.position.x > maxX + 40) break;
  }
  check(
    "flies over a roof unimpeded",
    crossed && d.position.x > maxX + 20 && deflected < 1e-6,
    `crossed = ${crossed}, reached x = ${d.position.x.toFixed(0)} (footprint ends at ${maxX.toFixed(0)}), ` +
    `largest push-out ${deflected.toFixed(6)} m`,
  );
}

// --- 7. Nothing gets through, and nothing goes NaN ------------------------
// Random stick in the densest part of the pack, from a start EXACTLY on a
// building vertex -- the one place where the outward direction is 0/0 and a
// missing guard turns the whole position into a NaN on the first frame.
//
// The invariant is not just finiteness. At no point may the drone END a step
// inside a building below its roof: an inside corner between two towers is the
// shape that defeats a single-pass solver, and 90 s of random walk through
// midtown finds a great many of them.
{
  // The collider's own drop rules, restated: pier decks and half-metre slivers
  // are not in the index, so they must not be in the oracle either.
  const near: { ring: Float32Array; baseY: number; topY: number }[] = [];
  for (const b of pack.buildings) {
    if (b.ring.length < 6) continue;
    if (b.topM - b.baseM <= MIN_HEIGHT_M) continue;
    if (Math.hypot(b.cx - tower.cx, b.cz - tower.cz) > 400) continue;
    const a = Math.abs(ringArea(b.ring));
    if (b.topM - b.baseM < SLAB_MAX_HEIGHT_M && a > SLAB_MIN_AREA_M2) continue;
    const per = ringPerimeter(b.ring);
    if (per < 1e-6 || (4 * a) / per < MIN_THICKNESS_M) continue;
    const gy = footprintGroundY(b, heightAt);
    near.push({ ring: b.ring, baseY: gy + b.baseM, topY: gy + b.topM });
  }

  let insideSteps = 0;
  let deepest = 0;
  let totalSteps = 0;
  let allFinite = true;
  let ran = 0;
  const last = new THREE.Vector3();

  for (const s0 of [24680, 13579, 99991]) {
    let seed = s0;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    // Seeded onto a different vertex of the tower each run, and at a height
    // partway up it, so every run starts embedded in a wall.
    const vi = (Math.abs(s0) % (tower.ring.length / 2)) * 2;
    const gy = footprintGroundY(tower, heightAt);
    const d = new Drone();
    d.enterFrom(new THREE.Vector3(0, 0, 0), 0, new THREE.Vector3());
    d.position.set(tower.ring[vi], gy + tower.topM * 0.4, tower.ring[vi + 1]);
    d.velocity.set(0, 0, 0);

    const steps = Math.round(30 / DT);
    for (let i = 0; i < steps; i++) {
      d.update(
        {
          forward: rnd(), strafe: rnd(), lift: rnd(), yaw: rnd(), pitch: rnd(),
          // Boost always on: the faster it moves, the deeper one frame of
          // penetration is and the more the solver has to undo.
          boost: 1, lookYawDeg: rnd() * 12, lookPitchDeg: rnd() * 12,
        },
        DT,
        heightAt(d.position.x, d.position.z),
      );
      col.resolve(d.position, d.velocity, R);
      totalSteps++;
      for (const b of near) {
        if (d.position.y > b.topY || d.position.y < b.baseY) continue;
        if (!pointInRing(b.ring, d.position.x, d.position.z)) continue;
        insideSteps++;
        if (b.topY - d.position.y > deepest) deepest = b.topY - d.position.y;
        break;
      }
    }
    if (
      !Number.isFinite(d.position.x) || !Number.isFinite(d.position.y) || !Number.isFinite(d.position.z) ||
      !Number.isFinite(d.velocity.x) || !Number.isFinite(d.velocity.y) || !Number.isFinite(d.velocity.z)
    ) allFinite = false;
    const away = Math.hypot(d.position.x - tower.cx, d.position.z - tower.cz);
    if (away > ran) ran = away;
    last.copy(d.position);
  }

  check(
    "90 s of random stick never ends a step inside a building",
    insideSteps === 0,
    `${insideSteps} of ${totalSteps} steps inside one of ${near.length} footprints ` +
    `(deepest ${deepest.toFixed(1)} m below a roof)`,
  );
  check(
    "stays finite under random stick in dense geometry",
    allFinite,
    `last run ended at ${last.toArray().map((v) => v.toFixed(0)).join(",")}`,
  );
  check(
    "contact never flings it out of the world",
    allFinite && ran < 2000,
    `${ran.toFixed(0)} m is the furthest any run drifted from the tower`,
  );
}

// --- Extraction from a wedge ------------------------------------------------
// One frame of penetration, put back where it came from.
//
// Manhattan is built on party walls and OSM overlaps its footprints freely, so
// pushing the drone out of the building it hit very often puts it inside the
// one next door. That is the state no flight test reliably reaches -- it needs
// the drone a metre inside a shared wall at the moment a step ends -- and it is
// the state that decides whether the machine feels solid or feels like it is
// negotiating with the geometry. So it is set up directly, thousands of times.
//
// Everything here is seeded, so both numbers are exact and neither is a
// tolerance around a noisy measurement.
//
// The bar is in two parts, and the second is the real one. A single resolve may
// leave a few starts inside something, because a local push-out cannot see the
// shape of a whole block. What may NOT happen is a start that never comes free:
// after eight frames, every remaining one has to be a place where a 2.4 m drone
// does not fit at all, which is a fact about the city rather than about this
// file.
{
  interface Near { ring: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number; baseY: number; topY: number }
  const dense: Near[] = [];
  for (const b of pack.buildings) {
    // The collider's own drop rules, restated. An oracle that counted the
    // footprints the collider deliberately ignores -- the pier decks, the
    // half-metre slivers -- would be asserting collision against things
    // nothing draws and nothing can be pushed out of.
    if (b.ring.length < 6) continue;
    if (b.topM - b.baseM <= MIN_HEIGHT_M) continue;
    if (Math.hypot(b.cx - tower.cx, b.cz - tower.cz) > 500) continue;
    const a = Math.abs(ringArea(b.ring));
    if (b.topM - b.baseM < SLAB_MAX_HEIGHT_M && a > SLAB_MIN_AREA_M2) continue;
    const per = ringPerimeter(b.ring);
    if (per < 1e-6 || (4 * a) / per < MIN_THICKNESS_M) continue;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < b.ring.length; i += 2) {
      if (b.ring[i] < minX) minX = b.ring[i];
      if (b.ring[i] > maxX) maxX = b.ring[i];
      if (b.ring[i + 1] < minZ) minZ = b.ring[i + 1];
      if (b.ring[i + 1] > maxZ) maxZ = b.ring[i + 1];
    }
    const gy = footprintGroundY(b, heightAt);
    dense.push({ ring: b.ring, minX, minZ, maxX, maxZ, baseY: gy + b.baseM, topY: gy + b.topM });
  }

  /** Nearest distance from a point to the ring, ignoring inside/outside. */
  const distToRing = (ring: Float32Array, qx: number, qz: number): number => {
    let best = Infinity;
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j * 2], az = ring[j * 2 + 1], bx = ring[i * 2], bz = ring[i * 2 + 1];
      const ex = bx - ax, ez = bz - az;
      const l2 = ex * ex + ez * ez;
      let t = l2 > 1e-12 ? ((qx - ax) * ex + (qz - az) * ez) / l2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const d = Math.hypot(qx - ax - ex * t, qz - az - ez * t);
      if (d < best) best = d;
    }
    return best;
  };

  const insideAnything = (qx: number, qy: number, qz: number): boolean => {
    for (const o of dense) {
      if (qx < o.minX || qx > o.maxX || qz < o.minZ || qz > o.maxZ) continue;
      if (qy > o.topY || qy < o.baseY) continue;
      if (pointInRing(o.ring, qx, qz)) return true;
    }
    return false;
  };

  /** Is there anywhere within 8 m that a circle of the drone's radius fits? */
  const roomNearby = (qx: number, qy: number, qz: number): boolean => {
    for (let a = 0; a < 96; a++) {
      for (const rad of [1.5, 2.5, 4, 6, 8]) {
        const tx = qx + Math.cos((a * Math.PI) / 48) * rad;
        const tz = qz + Math.sin((a * Math.PI) / 48) * rad;
        let ok = true;
        for (const o of dense) {
          if (qy > o.topY || qy < o.baseY) continue;
          if (tx < o.minX - R || tx > o.maxX + R || tz < o.minZ - R || tz > o.maxZ + R) continue;
          if (pointInRing(o.ring, tx, tz) || distToRing(o.ring, tx, tz) < R) { ok = false; break; }
        }
        if (ok) return true;
      }
    }
    return false;
  };

  let seed = 5150;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const pp = new THREE.Vector3();
  const pv = new THREE.Vector3();
  let trials = 0, stuckOnce = 0, stuckAfterEight = 0, noRoom = 0, attempts = 0;
  while (trials < 4000 && attempts < 400000) {
    attempts++;
    const b = dense[Math.floor(rnd() * dense.length)];
    const n = b.ring.length / 2;
    const i = Math.floor(rnd() * n), j = (i + 1) % n;
    const x0 = b.ring[i * 2], z0 = b.ring[i * 2 + 1];
    const x1 = b.ring[j * 2], z1 = b.ring[j * 2 + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 2) continue;
    const t = 0.15 + rnd() * 0.7;
    const ex = (x1 - x0) / len, ez = (z1 - z0) / len;
    // The side that is IN, found by asking rather than assuming a winding.
    let ix = -ez, iz = ex;
    if (!pointInRing(b.ring, x0 + ex * len * t + ix * 0.3, z0 + ez * len * t + iz * 0.3)) { ix = -ix; iz = -iz; }
    // 0.1 to 0.75 m inside: exactly what one 60 Hz frame at boost can produce,
    // and nothing deeper. Asserting an escape from three metres in would be
    // asserting something the drone can never get itself into.
    const depth = 0.1 + rnd() * 0.65;
    const px = x0 + ex * len * t + ix * depth;
    const pz = z0 + ez * len * t + iz * depth;
    if (!pointInRing(b.ring, px, pz)) continue;
    const py = b.baseY + (b.topY - b.baseY) * (0.3 + rnd() * 0.4);
    if (py - b.baseY < R * 2) continue;
    // The face has to be one the drone could actually have come in through:
    // open air on the other side, not the interior of the next building along.
    if (insideAnything(px - ix * (depth + 1.5), py, pz - iz * (depth + 1.5))) continue;

    trials++;
    pp.set(px, py, pz);
    pv.set(0, 0, 0);
    col.resolve(pp, pv, R);
    if (!insideAnything(pp.x, pp.y, pp.z)) continue;
    stuckOnce++;

    for (let g = 0; g < 8; g++) {
      col.resolve(pp, pv, R);
      if (!insideAnything(pp.x, pp.y, pp.z)) break;
    }
    if (!insideAnything(pp.x, pp.y, pp.z)) continue;
    stuckAfterEight++;
    if (!roomNearby(px, py, pz)) noRoom++;
  }

  check(
    "one frame of penetration is mostly cleared by one resolve",
    trials > 2000 && stuckOnce < trials * 0.01,
    `${stuckOnce} of ${trials} one-frame penetrations still inside something after one resolve ` +
    `(${((stuckOnce / trials) * 100).toFixed(2)}%, gate 1%)`,
  );
  check(
    "nothing stays stuck where the drone would fit",
    stuckAfterEight === noRoom,
    `${stuckAfterEight} still inside after 8 more resolves, and ${noRoom} of those are ` +
    `gaps too narrow for a ${(R * 2).toFixed(1)} m drone in the first place`,
  );
}

// --- Degenerate contact points ---------------------------------------------
// Exactly on a vertex and exactly on an edge: the two places where the outward
// direction is 0/0. Aimed at directly, because a fuzz will never land on
// either by accident.
{
  let allFinite = true;
  let worst = "";
  const probes: { x: number; z: number; y: number; what: string }[] = [];
  for (const b of [tower, helipad, wall.b]) {
    const gy = footprintGroundY(b, heightAt);
    const y = gy + b.baseM + Math.min(5, (b.topM - b.baseM) * 0.5);
    probes.push({ x: b.ring[0], z: b.ring[1], y, what: "on a vertex" });
    probes.push({ x: (b.ring[0] + b.ring[2]) * 0.5, z: (b.ring[1] + b.ring[3]) * 0.5, y, what: "on an edge" });
    probes.push({ x: b.cx, z: b.cz, y, what: "at the centroid" });
  }
  const pp = new THREE.Vector3();
  const pv = new THREE.Vector3();
  for (const probe of probes) {
    pp.set(probe.x, probe.y, probe.z);
    pv.set(0, -5, 0);
    col.resolve(pp, pv, R);
    const ok =
      Number.isFinite(pp.x) && Number.isFinite(pp.y) && Number.isFinite(pp.z) &&
      Number.isFinite(pv.x) && Number.isFinite(pv.y) && Number.isFinite(pv.z);
    if (!ok) { allFinite = false; worst = probe.what; }
  }
  check(
    "degenerate contact points do not divide by zero",
    allFinite,
    allFinite ? `${probes.length} vertex/edge/centroid probes all finite` : `NaN ${worst}`,
  );
}

// --- 8. Frame-rate independence --------------------------------------------
// The push-out is a POSITION correction, so it must not scale with dt. The way
// to get this wrong is to write the slide as an impulse and multiply it by the
// timestep, which looks right at 60 Hz and nowhere else.
{
  const w = wall;
  const dx = (w.x1 - w.x0) / w.len, dz = (w.z1 - w.z0) / w.len;
  const midX = (w.x0 + w.x1) * 0.5, midZ = (w.z0 + w.z1) * 0.5;
  let nx = dz, nz = -dx;
  if (pointInRing(w.b.ring, midX + nx * 0.5, midZ + nz * 0.5)) { nx = -nx; nz = -nz; }
  const topY = topYOf(w.b);
  const baseY = footprintGroundY(w.b, heightAt) + w.b.baseM;
  const flyY = (baseY + topY) * 0.5;
  const ax = (nx * -1 + dx) / Math.SQRT2;
  const az = (nz * -1 + dz) / Math.SQRT2;
  const yaw = headingTo(0, 0, ax, az);

  const run = (dt: number): THREE.Vector3 => {
    const d = new Drone();
    d.enterFrom(new THREE.Vector3(0, flyY, 0), yaw, new THREE.Vector3());
    d.position.set(midX + nx * 40 - ax * 40, flyY, midZ + nz * 40 - az * 40);
    d.velocity.set(ax * 30, 0, az * 30);
    const steps = Math.round(5 / dt);
    for (let i = 0; i < steps; i++) {
      d.update({ ...NEUTRAL, forward: 1 }, dt, heightAt(d.position.x, d.position.z));
      col.resolve(d.position, d.velocity, R);
    }
    return d.position.clone();
  };
  const slow = run(1 / 30);
  const fast = run(1 / 240);
  const gap = slow.distanceTo(fast);
  check(
    "the same skim ends in the same place at 30 and 240 Hz",
    gap < 1,
    `${gap.toFixed(2)} m apart after 5 s of contact (want < 1 m)`,
  );
}

// --- Report ----------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(48)} ${r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} collision checks passed`);
if (failed) process.exit(1);
