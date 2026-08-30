// Ground-truth ambient occlusion: the horizon search and the arc integral, with
// no THREE and no DOM in it.
//
// The variant is Jimenez, Wu, Pesce and Jarabo, "Practical Realtime Strategies
// for Accurate Indirect Occlusion" (SIGGRAPH 2016 courses) -- GTAO. It is not
// the older "count occluded samples inside a sphere" SSAO. The difference is
// the whole reason this file exists: SSAO's occlusion is a sample count with no
// units and no analytic answer, so nothing about it can be gated. GTAO computes
//
//     V = (1/N) * sum over slices of |n_proj| * integral of cos(t - g) |sin t| dt
//
// between the two horizon angles found along that slice, which for an
// unoccluded surface is exactly 1 and for a surface at the bottom of a
// quarter-space is exactly 1/2. Those are numbers a test can assert.
//
// Split out from the pass that runs it (render/ao.ts) for the same reason sh.ts
// is split out from skyprobe.ts: the maths is what goes subtly wrong, the maths
// needs no GPU, and test/gtao.check.ts drives exactly these functions with
// synthetic depth buffers.
//
// THE INTEGRALS, derived rather than copied, so the signs are ours:
//
//   A direction in a slice is w(t) = V cos t + T sin t, where V points at the
//   camera and T is the in-plane tangent along the +screen-direction side. The
//   projected normal sits at angle g in that basis. The cosine-weighted
//   visibility of the arc [h1, h2] is
//
//     a  = INT cos(t - g) |sin t| dt
//     t1 = INT cos t   cos(t - g) |sin t| dt      (the V component of the bent normal)
//     t0 = INT sin t   cos(t - g) |sin t| dt      (the T component)
//
//   all over [h1, h2] with h1 <= 0 <= h2. Splitting at zero to resolve |sin t|
//   and integrating gives the closed forms below. They agree term for term with
//   the paper's listing, which is the check that the derivation is right.

/** Half pi, spelled once. */
const HALF_PI = Math.PI / 2;

/** Perspective projection, reduced to what a screen-space pass actually needs. */
export interface Projection {
  /** tan(vertical field of view / 2). */
  tanHalfFov: number;
  /** width / height. */
  aspect: number;
}

/**
 * A screen-space depth buffer, as LINEAR view distance along -z in metres.
 *
 * Linear rather than post-projection z because everything downstream wants
 * metres, and because the reconstruction from a hardware depth buffer is a
 * property of the pass (render/ao.ts) rather than of the algorithm. `Infinity`
 * means nothing was drawn: sky, or geometry past the pass's own far plane.
 */
export interface DepthField {
  width: number;
  height: number;
  /** Row 0 at the bottom, matching gl_FragCoord. */
  depth: Float32Array;
}

export interface GtaoSettings {
  /** Slices around the pixel. Each one searches both ways, so they span pi. */
  slices: number;
  /** Horizon samples per direction, per slice. */
  stepsPerSlice: number;
  /**
   * Exponent on the step spacing. 1 is uniform; 2 packs the early samples in
   * close to the query and spreads the late ones out.
   *
   * Uniform spacing is what most implementations use and it is the wrong
   * distribution for this scene. Occlusion falls off with distance, so the
   * samples that matter most are the near ones, and a uniform march over a
   * radius wide enough to reach the next building steps straight over the kerb
   * at its feet: the first sample already lands metres away and the horizon
   * comes back far too open. Squaring puts a quarter of the samples inside the
   * first quarter of the radius.
   */
  stepCurve: number;
  /** Search radius in world metres at the query point. */
  radiusM: number;
  /** Upper bound on the projected radius, so a close-up pixel cannot cost the frame. */
  maxRadiusPx: number;
  /**
   * World distance at which an occluder stops counting, as a fraction of
   * radiusM. Below this it counts in full; between here and 1 it fades out.
   * This is GTAO's thickness heuristic: a screen-space search cannot tell a
   * nearby wall from a distant object that happens to be in front, and without
   * a falloff the distant one casts occlusion across a gap it is not in.
   */
  falloffStart: number;
  /** Slice rotation, in turns, in [0, 1). Per pixel, to trade banding for noise. */
  rotationJitter: number;
  /** Step offset, in steps, in [0, 1). Per pixel, same purpose. */
  stepJitter: number;
}

export const DEFAULT_SETTINGS: GtaoSettings = {
  slices: 3,
  stepsPerSlice: 6,
  stepCurve: 2,
  radiusM: 14,
  maxRadiusPx: 96,
  falloffStart: 0.6,
  rotationJitter: 0,
  stepJitter: 0,
};

export interface GtaoResult {
  /** Cosine-weighted fraction of the hemisphere that is open. */
  visibility: number;
  /** Unit average unoccluded direction, in the same space as the input normal. */
  bentNormal: Float32Array;
}

/**
 * View-space position of a pixel centre, or false when the pixel is sky.
 *
 * `x` and `y` are integer pixel indices with (0, 0) at the bottom left.
 */
export function viewPositionAt(
  buf: DepthField,
  proj: Projection,
  x: number,
  y: number,
  out: Float32Array,
): boolean {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return false;
  const d = buf.depth[y * buf.width + x];
  if (!Number.isFinite(d) || d <= 0) return false;
  const ndcX = ((x + 0.5) / buf.width) * 2 - 1;
  const ndcY = ((y + 0.5) / buf.height) * 2 - 1;
  out[0] = ndcX * proj.tanHalfFov * proj.aspect * d;
  out[1] = ndcY * proj.tanHalfFov * d;
  out[2] = -d;
  return true;
}

/** Pixels one metre subtends at unit view distance, vertically. */
export function focalLengthPx(proj: Projection, height: number): number {
  return height / (2 * proj.tanHalfFov);
}

/**
 * Cosine-weighted visibility of the arc [h1, h2] about a normal at angle g.
 *
 * h1 <= 0 <= h2, both already clamped into [g - pi/2, g + pi/2]. An unclipped
 * hemisphere (g = 0, h1 = -pi/2, h2 = pi/2) returns exactly 1.
 */
export function sliceVisibility(h1: number, h2: number, g: number): number {
  const cg = Math.cos(g);
  const sg = Math.sin(g);
  return (
    0.25 * (-Math.cos(2 * h1 - g) + cg + 2 * h1 * sg) +
    0.25 * (-Math.cos(2 * h2 - g) + cg + 2 * h2 * sg)
  );
}

/** Tangential (T) component of the slice's unnormalised bent normal. */
export function sliceBentTangent(h1: number, h2: number, g: number): number {
  return (
    (6 * Math.sin(h1 - g) - Math.sin(3 * h1 - g) +
      6 * Math.sin(h2 - g) - Math.sin(3 * h2 - g) +
      16 * Math.sin(g) -
      3 * (Math.sin(h1 + g) + Math.sin(h2 + g))) /
    12
  );
}

/** View (V) component of the slice's unnormalised bent normal. */
export function sliceBentView(h1: number, h2: number, g: number): number {
  return (
    (-Math.cos(3 * h1 - g) - Math.cos(3 * h2 - g) +
      8 * Math.cos(g) -
      3 * (Math.cos(h1 + g) + Math.cos(h2 + g))) /
    12
  );
}

const _pos = new Float32Array(3);
const _n = new Float32Array(3);
const _q = new Float32Array(3);
const _v = new Float32Array(3);
const _t = new Float32Array(3);
const _axis = new Float32Array(3);
const _nProj = new Float32Array(3);
const _bent = new Float32Array(3);

function dot(a: Float32Array, b: Float32Array): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Float32Array, b: Float32Array, out: Float32Array): void {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

function normalise(v: Float32Array): number {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len > 1e-12) {
    v[0] /= len;
    v[1] /= len;
    v[2] /= len;
  }
  return len;
}

/**
 * Visibility and bent normal at one pixel.
 *
 * `viewNormal` is the surface normal in view space. It is an INPUT rather than
 * something derived here so the test can hand in the exact analytic normal and
 * gate the integral on its own, without a depth-derivative reconstruction in
 * the way. The pass reconstructs it from the same depth buffer; see ao.ts.
 */
export function gtaoSample(
  buf: DepthField,
  proj: Projection,
  x: number,
  y: number,
  viewNormal: ArrayLike<number>,
  s: GtaoSettings,
  out?: GtaoResult,
): GtaoResult {
  const result: GtaoResult = out ?? { visibility: 1, bentNormal: new Float32Array(3) };
  const n = _n;
  const pos = _pos;
  const bent = _bent;

  if (!viewPositionAt(buf, proj, x, y, pos)) {
    result.visibility = 1;
    result.bentNormal[0] = viewNormal[0];
    result.bentNormal[1] = viewNormal[1];
    result.bentNormal[2] = viewNormal[2];
    return result;
  }

  n[0] = viewNormal[0];
  n[1] = viewNormal[1];
  n[2] = viewNormal[2];

  // V points from the surface back at the camera.
  _v[0] = -pos[0];
  _v[1] = -pos[1];
  _v[2] = -pos[2];
  normalise(_v);

  const depth = -pos[2];
  const radiusPx = Math.min(
    s.maxRadiusPx,
    (s.radiusM * focalLengthPx(proj, buf.height)) / Math.max(depth, 1e-4),
  );

  bent[0] = 0;
  bent[1] = 0;
  bent[2] = 0;

  // Under a pixel of search radius there is nothing to search: every sample
  // would land on the query pixel itself.
  if (!(radiusPx >= 1)) {
    result.visibility = 1;
    result.bentNormal[0] = n[0];
    result.bentNormal[1] = n[1];
    result.bentNormal[2] = n[2];
    return result;
  }

  const fadeStart = s.falloffStart * s.radiusM;
  const fadeSpan = Math.max(1e-4, s.radiusM - fadeStart);

  let visibility = 0;

  for (let slice = 0; slice < s.slices; slice++) {
    const phi = ((slice + s.rotationJitter) * Math.PI) / s.slices;
    const dx = Math.cos(phi);
    const dy = Math.sin(phi);

    // Slice basis. The screen direction is treated as a view-space direction in
    // the xy plane, which is the standard GTAO approximation: it is exact at
    // the centre of the frame and the error is a fraction of a slice's width at
    // the edge, well under the noise the search itself carries.
    _t[0] = dx;
    _t[1] = dy;
    _t[2] = 0;
    cross(_t, _v, _axis);
    if (normalise(_axis) < 1e-9) continue;
    cross(_v, _axis, _t);
    normalise(_t);

    const nDotAxis = dot(n, _axis);
    _nProj[0] = n[0] - _axis[0] * nDotAxis;
    _nProj[1] = n[1] - _axis[1] * nDotAxis;
    _nProj[2] = n[2] - _axis[2] * nDotAxis;
    const projLen = normalise(_nProj);
    if (projLen < 1e-6) continue;

    const g = Math.atan2(dot(_nProj, _t), dot(_nProj, _v));

    // -1 is "no occluder anywhere", which clamps below to the open hemisphere.
    let cosPos = -1;
    let cosNeg = -1;

    for (let step = 0; step < s.stepsPerSlice; step++) {
      const d = radiusPx * Math.pow((step + 1 + s.stepJitter) / s.stepsPerSlice, s.stepCurve);
      const ox = dx * d;
      const oy = dy * d;

      for (let side = 0; side < 2; side++) {
        const sx = Math.round(x + (side === 0 ? ox : -ox));
        const sy = Math.round(y + (side === 0 ? oy : -oy));
        if (!viewPositionAt(buf, proj, sx, sy, _q)) continue;
        const ex = _q[0] - pos[0];
        const ey = _q[1] - pos[1];
        const ez = _q[2] - pos[2];
        const len = Math.hypot(ex, ey, ez);
        if (len < 1e-6) continue;
        const cosTheta = (ex * _v[0] + ey * _v[1] + ez * _v[2]) / len;
        // Thickness falloff, applied to the CANDIDATE rather than to the
        // accumulated horizon, so it can only ever weaken a distant occluder
        // and never pull an established near horizon back open.
        const w = Math.min(1, Math.max(0, 1 - (len - fadeStart) / fadeSpan));
        if (side === 0) {
          cosPos = Math.max(cosPos, cosPos + (cosTheta - cosPos) * w);
        } else {
          cosNeg = Math.max(cosNeg, cosNeg + (cosTheta - cosNeg) * w);
        }
      }
    }

    const hPos = Math.acos(Math.min(1, Math.max(-1, cosPos)));
    const hNeg = -Math.acos(Math.min(1, Math.max(-1, cosNeg)));
    const h2 = g + Math.min(hPos - g, HALF_PI);
    const h1 = g + Math.max(hNeg - g, -HALF_PI);

    visibility += projLen * sliceVisibility(h1, h2, g);

    const bt = sliceBentTangent(h1, h2, g);
    const bv = sliceBentView(h1, h2, g);
    bent[0] += projLen * (_t[0] * bt + _v[0] * bv);
    bent[1] += projLen * (_t[1] * bt + _v[1] * bv);
    bent[2] += projLen * (_t[2] * bt + _v[2] * bv);
  }

  visibility = Math.min(1, Math.max(0, visibility / s.slices));

  // A fully closed hemisphere leaves nothing to point at; the geometric normal
  // is the only defensible answer and it keeps the vector unit length.
  if (normalise(bent) < 1e-7) {
    bent[0] = n[0];
    bent[1] = n[1];
    bent[2] = n[2];
  }

  result.visibility = visibility;
  result.bentNormal[0] = bent[0];
  result.bentNormal[1] = bent[1];
  result.bentNormal[2] = bent[2];
  return result;
}

// --- GLSL --------------------------------------------------------------------

/**
 * The same search and the same integrals, for the AO pass.
 *
 * Kept beside the TypeScript rather than in the pass file so the two can be
 * read against each other in one screen, which is the only defence against them
 * drifting: nothing in the build can check that a GLSL `acos` chain matches a
 * TypeScript one.
 *
 * The caller supplies `gtaoViewPos(vec2 uv)` returning view position with
 * `.z >= 0.0` meaning sky.
 */
export const GTAO_GLSL = /* glsl */ `
const float GTAO_HALF_PI = 1.57079632679;

/** Cosine-weighted visibility of the arc [h1, h2] about a normal at angle g. */
float gtaoSliceVisibility(float h1, float h2, float g) {
  float cg = cos(g);
  float sg = sin(g);
  return 0.25 * (-cos(2.0 * h1 - g) + cg + 2.0 * h1 * sg)
       + 0.25 * (-cos(2.0 * h2 - g) + cg + 2.0 * h2 * sg);
}

/** Tangential component of the slice's unnormalised bent normal. */
float gtaoSliceBentTangent(float h1, float h2, float g) {
  return (6.0 * sin(h1 - g) - sin(3.0 * h1 - g)
        + 6.0 * sin(h2 - g) - sin(3.0 * h2 - g)
        + 16.0 * sin(g)
        - 3.0 * (sin(h1 + g) + sin(h2 + g))) / 12.0;
}

/** View component of the slice's unnormalised bent normal. */
float gtaoSliceBentView(float h1, float h2, float g) {
  return (-cos(3.0 * h1 - g) - cos(3.0 * h2 - g)
        + 8.0 * cos(g)
        - 3.0 * (cos(h1 + g) + cos(h2 + g))) / 12.0;
}
`;
