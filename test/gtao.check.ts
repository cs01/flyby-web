// The gate on the ground-truth ambient occlusion maths.
//
// The pass that runs it needs a GPU, a depth prepass and a half-resolution
// target, none of which exist under Bun. What CAN be pinned down is the part
// that is easy to get wrong and impossible to see: the horizon search, the
// cosine-weighted arc integral, and the bent normal that falls out of it. Every
// failure mode here renders as "the corners look a bit off" rather than as a
// crash.
//
// The scenes are synthetic DEPTH BUFFERS, ray-cast from analytic planes by the
// tiny renderer below. That is what makes the expected values derivable: for
// half of these configurations the cosine-weighted visibility has a closed
// form, and the closed form is computed here from Math.PI and the scene's own
// dimensions, never from src/render/gtao.ts. Tolerances are literals for the
// same reason -- a threshold read out of the thing it is checking moves its own
// goalposts and can never go red.
//
// The two analytic answers used below:
//
//   QUARTER SPACE. A point on the floor at the base of a perpendicular wall
//   sees exactly half its hemisphere, and cosine weighting is symmetric about
//   the normal, so visibility is exactly 1/2.
//
//   BENT NORMAL OF A QUARTER SPACE. Integrating w cos(w.n) over the open half
//   gives (2/3) along the opening and (pi/3) along the normal, so the bent
//   normal leans atan(2/pi) = 32.48 degrees away from the wall. Both components
//   are elementary integrals over the half hemisphere and neither involves the
//   module under test.
//
// Each block also carries a VACUITY PROBE: the same predicate fed a
// configuration in which it could not possibly detect anything, asserted to
// come back false. An assertion that passes on an unoccluded plane is not
// testing occlusion.

import {
  DEFAULT_SETTINGS,
  gtaoSample,
  type DepthField,
  type GtaoSettings,
  type Projection,
} from "../src/render/gtao";

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

// --- a very small analytic renderer ------------------------------------------
//
// Planes, optionally clipped by a predicate, ray-cast per pixel into a linear
// view-depth buffer. This is the whole reason the scenes can be described in
// world metres and the expected answers in closed form.

type V3 = [number, number, number];

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addv = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulv = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** The plane dot(n, X) = d, existing only where `inside` holds. */
interface Face {
  n: V3;
  d: number;
  inside?: (x: V3) => boolean;
}

interface Camera {
  pos: V3;
  right: V3;
  up: V3;
  fwd: V3;
}

/** A camera at `height` metres over the world origin, pitched down. */
function camera(height: number, pitchDeg: number): Camera {
  const p = (pitchDeg * Math.PI) / 180;
  return {
    pos: [0, height, 0],
    right: [1, 0, 0],
    up: [0, Math.cos(p), -Math.sin(p)],
    fwd: [0, -Math.sin(p), -Math.cos(p)],
  };
}

/** Straight down, so a trench's vertical walls are edge-on and invisible. */
function overhead(height: number, rollRad = 0): Camera {
  const c = Math.cos(rollRad);
  const s = Math.sin(rollRad);
  return {
    pos: [0, height, 0],
    right: [c, 0, -s],
    up: [s, 0, -c],
    fwd: [0, -1, 0],
  };
}

interface Rendered {
  buf: DepthField;
  /** View-space surface normal per pixel, three floats each. */
  normals: Float32Array;
}

const PROJ: Projection = { tanHalfFov: Math.tan((62 * Math.PI) / 360), aspect: 16 / 9 };
const W = 640;
const H = 360;

/** View-space ray for a pixel centre, with z fixed at -1 so t IS the depth. */
function pixelRay(px: number, py: number): V3 {
  const ndcX = ((px + 0.5) / W) * 2 - 1;
  const ndcY = ((py + 0.5) / H) * 2 - 1;
  return [ndcX * PROJ.tanHalfFov * PROJ.aspect, ndcY * PROJ.tanHalfFov, -1];
}

function render(faces: Face[], cam: Camera): Rendered {
  const depth = new Float32Array(W * H).fill(Infinity);
  const normals = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = pixelRay(x, y);
      const dir: V3 = [
        cam.right[0] * v[0] + cam.up[0] * v[1] - cam.fwd[0] * v[2],
        cam.right[1] * v[0] + cam.up[1] * v[1] - cam.fwd[1] * v[2],
        cam.right[2] * v[0] + cam.up[2] * v[1] - cam.fwd[2] * v[2],
      ];
      let bestT = Infinity;
      let bestN: V3 | null = null;
      for (const f of faces) {
        const den = dot3(f.n, dir);
        if (Math.abs(den) < 1e-12) continue;
        const t = (f.d - dot3(f.n, cam.pos)) / den;
        if (t <= 1e-6 || t >= bestT) continue;
        const hit = addv(cam.pos, mulv(dir, t));
        if (f.inside && !f.inside(hit)) continue;
        bestT = t;
        // Face the camera: a plane has two sides and only one of them is lit.
        bestN = den < 0 ? f.n : (mulv(f.n, -1) as V3);
      }
      if (!bestN) continue;
      const i = y * W + x;
      depth[i] = bestT;
      normals[i * 3] = dot3(bestN, cam.right);
      normals[i * 3 + 1] = dot3(bestN, cam.up);
      normals[i * 3 + 2] = -dot3(bestN, cam.fwd);
    }
  }
  return { buf: { width: W, height: H, depth }, normals };
}

const normalAt = (r: Rendered, x: number, y: number): Float32Array =>
  r.normals.slice((y * W + x) * 3, (y * W + x) * 3 + 3);

/** Direction in view space of a world direction, for asserting which way a bent normal leans. */
const toView = (cam: Camera, w: V3): V3 => [
  dot3(w, cam.right),
  dot3(w, cam.up),
  -dot3(w, cam.fwd),
];

// Eight slices and twelve steps: far more than the pass affords per pixel, and
// deliberately so. This gates the INTEGRAL, not the sampling budget, and a
// tolerance loose enough to absorb a three-slice search would be loose enough
// to absorb a wrong integral too.
const S: GtaoSettings = {
  ...DEFAULT_SETTINGS,
  slices: 8,
  stepsPerSlice: 12,
  radiusM: 6,
  maxRadiusPx: 512,
  falloffStart: 1,
};

const GROUND: Face = { n: [0, 1, 0], d: 0 };

// --- 1. a flat unoccluded plane ----------------------------------------------
//
// Nothing occludes anything, so every slice runs to its clamped hemisphere
// limits and the integral collapses to its closed form: visibility 1, bent
// normal exactly the geometric normal. This is the case a sign error in the
// clamping shows up in immediately -- swapping the two horizon clamps takes it
// to 0.
//
// Watched to fail: changing `-HALF_PI` to `-1.0` in the h1 clamp took this to
// 0.8613, and the corner block below to 0.4402.

let flatVis = 0;
let flatBentDot = 0;
{
  const cam = camera(20, 45);
  const r = render([GROUND], cam);
  const px = W >> 1;
  const py = H >> 1;
  const n = normalAt(r, px, py);
  const g = gtaoSample(r.buf, PROJ, px, py, n, S);
  flatVis = g.visibility;
  flatBentDot = g.bentNormal[0] * n[0] + g.bentNormal[1] * n[1] + g.bentNormal[2] * n[2];

  check("flat plane is unoccluded", Math.abs(flatVis - 1) < 5e-3, `visibility ${flatVis.toFixed(5)}`);
  check(
    "flat plane bends nowhere",
    flatBentDot > 1 - 1e-4,
    `dot(bent, n) ${flatBentDot.toFixed(6)}`,
  );
}

// --- 2. an inside corner ------------------------------------------------------
//
// Floor plus a wall at 90 degrees, queried at the last floor pixel before the
// wall. That is a quarter space: exactly half the hemisphere, so 1/2, and a
// bent normal leaning atan(2/pi) away from the wall.
//
// A screen-space search cannot land exactly on the corner -- the query pixel is
// up to one pixel short of the wall base -- so the tolerance is wide enough for
// that and no wider. It is nowhere near wide enough to admit 1.0.
//
// Watched to fail: dropping the |sin t| Jacobian (integrating cos(t - g) alone)
// took this to 0.6035 and the flat plane to 1.1107.

const QUARTER_SPACE_VISIBILITY = 0.5;
// (2/3) along the opening, (pi/3) along the normal; see the header.
const QUARTER_SPACE_TILT_DEG = (Math.atan(2 / 3 / (Math.PI / 3)) * 180) / Math.PI;

/** The predicate under test, named so the vacuity probe can reuse it verbatim. */
const readsAsACorner = (v: number): boolean => Math.abs(v - QUARTER_SPACE_VISIBILITY) < 0.06;

const WALL_Z = -30;
const cornerFaces: Face[] = [
  { ...GROUND, inside: (x) => x[2] > WALL_Z },
  { n: [0, 0, 1], d: WALL_Z, inside: (x) => x[1] > 0 && x[1] < 60 },
];

{
  const cam = camera(12, 25);
  const r = render(cornerFaces, cam);
  const px = W >> 1;
  // The topmost floor pixel in the centre column is the one at the wall base.
  let py = 0;
  for (let y = 0; y < H; y++) {
    const i = y * W + px;
    if (Number.isFinite(r.buf.depth[i]) && r.normals[i * 3 + 1] > 0.5) py = y;
  }
  const n = normalAt(r, px, py);
  const g = gtaoSample(r.buf, PROJ, px, py, n, S);
  const b = g.bentNormal;

  check(
    "inside corner reads as a quarter space",
    readsAsACorner(g.visibility),
    `visibility ${g.visibility.toFixed(5)}, analytic ${QUARTER_SPACE_VISIBILITY}`,
  );

  const wallN = toView(cam, [0, 0, 1]);
  const dFloor = b[0] * n[0] + b[1] * n[1] + b[2] * n[2];
  const dWall = b[0] * wallN[0] + b[1] * wallN[1] + b[2] * wallN[2];
  const tiltDeg = (Math.acos(Math.min(1, dFloor)) * 180) / Math.PI;

  check(
    "corner bent normal leans out of the corner",
    dFloor > 0 && dWall > 0,
    `dot(floor) ${dFloor.toFixed(4)}, dot(wall) ${dWall.toFixed(4)}`,
  );
  check(
    "corner bent normal bisects the opening",
    Math.abs(tiltDeg - QUARTER_SPACE_TILT_DEG) < 3,
    `${tiltDeg.toFixed(2)} deg, analytic ${QUARTER_SPACE_TILT_DEG.toFixed(2)}`,
  );

  // VACUITY PROBE. The flat plane has no corner in it at all. If the corner
  // predicate accepts it, the predicate is measuring nothing.
  check(
    "corner test rejects an unoccluded plane",
    !readsAsACorner(flatVis),
    `flat plane visibility ${flatVis.toFixed(5)} would have to be near ${QUARTER_SPACE_VISIBILITY}`,
  );
  // The same for the bent normal: on the flat plane it is the geometric normal,
  // so a "leans out of the corner" test that accepted zero tilt would be idle.
  const flatTilt = (Math.acos(Math.min(1, flatBentDot)) * 180) / Math.PI;
  check(
    "bisector test rejects a plane's own normal",
    !(Math.abs(flatTilt - QUARTER_SPACE_TILT_DEG) < 3),
    `flat plane tilt ${flatTilt.toFixed(2)} deg`,
  );
}

// --- 3. a deep narrow slot against a wide shallow one -------------------------
//
// Both trenches have their floor at the same view distance, and the camera is
// straight overhead so the trench walls are edge-on and contribute no pixels:
// the only occluder either query can find is the lip of the trench, which is
// the honest screen-space case. Narrower and deeper puts that lip nearer the
// zenith, so it must be darker.
//
// The absolute values are NOT asserted. A screen-space search steps outward
// from the query pixel and its first step already overshoots the lip of a 2 m
// trench, so it recovers the ORDER faithfully and the magnitude only roughly;
// pinning the magnitude would be pinning the step count.

/** Trench of the given width and depth running along x, floor at y = -depth. */
function trench(width: number, depth: number): Face[] {
  const half = width / 2;
  return [
    { ...GROUND, inside: (x) => Math.abs(x[2]) > half },
    { n: [0, 1, 0], d: -depth, inside: (x) => Math.abs(x[2]) <= half },
    { n: [0, 0, 1], d: -half, inside: (x) => x[1] > -depth && x[1] < 0 },
    { n: [0, 0, -1], d: -half, inside: (x) => x[1] > -depth && x[1] < 0 },
  ];
}

/** Visibility at the centre of a trench floor held at `standoff` metres from the lens. */
function trenchVisibility(width: number, depth: number, standoff: number, rollRad = 0): number {
  const cam = overhead(-depth + standoff, rollRad);
  const r = render(trench(width, depth), cam);
  const px = W >> 1;
  const py = H >> 1;
  const wide: GtaoSettings = { ...S, radiusM: 30 };
  return gtaoSample(r.buf, PROJ, px, py, normalAt(r, px, py), wide).visibility;
}

const darkerThan = (a: number, b: number): boolean => a < b - 0.1;

{
  const STANDOFF = 40;
  const deep = trenchVisibility(2, 6, STANDOFF);
  const shallow = trenchVisibility(6, 2, STANDOFF);
  check(
    "a deep narrow slot is darker than a wide one",
    darkerThan(deep, shallow),
    `2x6 -> ${deep.toFixed(4)}, 6x2 -> ${shallow.toFixed(4)}`,
  );

  // VACUITY PROBE. Comparing a trench against ITSELF has no darkening in it,
  // so the ordering predicate must refuse it. Without this, `a < b + 1` would
  // pass the assertion above for ever.
  check(
    "slot ordering rejects a slot against itself",
    !darkerThan(deep, deep),
    `${deep.toFixed(4)} vs itself`,
  );
}

// --- 4. invariants over every pixel of every scene ----------------------------
//
// Visibility in [0, 1], bent normal unit length, and the bent normal never
// pointing into the surface. The last one is not decoration: it is what makes
// shIrradiance(bentNormal) meaningful at all, and a slice whose two horizons
// came back swapped violates it long before it visibly changes the visibility.

{
  const scenes: { name: string; faces: Face[]; cam: Camera }[] = [
    { name: "plane", faces: [GROUND], cam: camera(20, 45) },
    { name: "corner", faces: cornerFaces, cam: camera(12, 25) },
    { name: "trench", faces: trench(3, 5), cam: overhead(35) },
    { name: "grazing", faces: cornerFaces, cam: camera(3, 4) },
  ];
  let worstVis = 0;
  let worstLen = 0;
  let worstDot = 1;
  let tested = 0;
  const jittered: GtaoSettings = { ...S, slices: 3, stepsPerSlice: 5, rotationJitter: 0.37, stepJitter: 0.61 };
  for (const s of scenes) {
    const r = render(s.faces, s.cam);
    for (let y = 4; y < H; y += 17) {
      for (let x = 4; x < W; x += 23) {
        const i = y * W + x;
        if (!Number.isFinite(r.buf.depth[i])) continue;
        const n = normalAt(r, x, y);
        const g = gtaoSample(r.buf, PROJ, x, y, n, jittered);
        const b = g.bentNormal;
        tested++;
        worstVis = Math.max(worstVis, Math.max(-g.visibility, g.visibility - 1));
        worstLen = Math.max(worstLen, Math.abs(Math.hypot(b[0], b[1], b[2]) - 1));
        worstDot = Math.min(worstDot, b[0] * n[0] + b[1] * n[1] + b[2] * n[2]);
      }
    }
  }
  check("visibility stays in [0, 1]", tested > 500 && worstVis <= 0, `${tested} pixels, worst excursion ${worstVis.toExponential(2)}`);
  check("bent normal stays unit length", worstLen < 1e-5, `worst |len - 1| ${worstLen.toExponential(2)}`);
  check("bent normal never enters the surface", worstDot > 0, `worst dot(bent, n) ${worstDot.toFixed(5)}`);
}

// --- 5. rotational consistency -------------------------------------------------
//
// Roll the camera and the whole image rotates about the query, while every
// world distance and angle stays put. The slice directions are fixed in SCREEN
// space, so a search that leaned on a screen axis -- sampling only along x, or
// weighting the two axes differently -- would change its answer here and
// nowhere else.
//
// The residual is the sampling grid: rolled samples land on different texels of
// the same surface. Nothing about the integral depends on the roll.

{
  // The trench, viewed from straight overhead, with the query at the exact
  // centre of its floor. Rolling the camera turns the trench across the screen
  // without moving the query one millimetre relative to the geometry, so the
  // ONLY thing that changes is which screen directions the slices point along.
  // The corner scene would not do: rolling it lands the query pixel a
  // fractionally different distance from the wall base each time, and the
  // spread that produces is a different query, not a different answer.
  const rolls = [0, Math.PI / S.slices, 0.5, Math.PI / 2, 2.39];
  let lo = Infinity;
  let hi = -Infinity;
  for (const roll of rolls) {
    const v = trenchVisibility(3, 5, 35, roll);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  check(
    "rotating the scene leaves visibility alone",
    hi - lo < 0.02,
    `${rolls.length} rolls, spread ${(hi - lo).toFixed(5)} over ${lo.toFixed(4)}..${hi.toFixed(4)}`,
  );
}

console.log(failures === 0 ? "\nall gtao checks ok" : `\n${failures} gtao check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
