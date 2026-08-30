// Centreline -> triangle strip. One road becomes a flat ribbon of quads with a
// texture parameterisation that the road shader reads directly.
//
// THE `u` COORDINATE IS THE WHOLE POINT OF THIS FILE. `u` is the cumulative
// distance along the centreline in REAL METRES, continuous across every joint;
// `v` is 0 on one kerb and 1 on the other. Everything the asphalt shader draws
// falls out of that pair for free and in the right units: a dashed centreline
// is `mod(u, 12.0) < 3.0`, an edge line is a threshold on `v`, wheel polish is
// two gaussians in `v`, expansion joints in concrete are `mod(u, 4.5)`. If `u`
// is normalised, or resets per segment, or drifts at a joint, then every dash
// on the map is a different length and the markings shear where two segments
// meet. Getting `u` right matters more than anything else here.
//
// Deliberately PURE: no THREE, no DOM, no height field. That is what lets
// test/ribbon.check.ts run the real builder under Bun and assert on the actual
// numbers instead of on a copy of them.

/**
 * Longest mitre allowed, as a multiple of the half-width.
 *
 * A mitred joint runs out to h/cos(phi/2), which goes to infinity as a way
 * doubles back on itself. OSM is full of hairpins (switchbacks, cul-de-sac
 * heads, badly digitised kerb lines), and an unclamped mitre turns each one
 * into a spike hundreds of metres long lying across the city. Past the limit
 * the joint is BEVELLED instead: the centreline point is emitted twice, once
 * offset by each segment's own normal, so the outer corner is cut square and no
 * vertex can be further than MITRE_LIMIT * h from its centreline point.
 */
export const MITRE_LIMIT = 2.0;

/**
 * Two centreline points closer than this are the same point. Pack coordinates
 * are quantised to a quarter metre, so distinct points are at least 0.25 m
 * apart and anything below this is an exact duplicate (the baker emits them
 * where it split a long way). A zero-length segment has no direction, and one
 * NaN normal takes the entire strip with it.
 */
const DUP_EPS_M = 1e-4;

export interface RibbonScratch {
  /** x, z per vertex, local ENU metres. Vertices come in PAIRS. */
  xz: number[];
  /** u = metres along the centreline, v = 0 or 1 (never between). */
  uv: number[];
  idx: number[];
}

export function emptyRibbon(): RibbonScratch {
  return { xz: [], uv: [], idx: [] };
}

/**
 * Triangles a ribbon of `nPts` centreline points costs, for budgeting.
 * A lower bound: each bevelled joint adds two more.
 */
export function ribbonTriangleCost(nPts: number): number {
  return Math.max(0, nPts - 1) * 2;
}

/**
 * Append one road's ribbon to `s`. Returns the number of triangles added.
 *
 * INVARIANT the renderer and the gate both rely on: vertices are appended two
 * at a time and both members of a pair sit on the same centreline point, so
 * vertex `2k` carries v=0 and vertex `2k+1` carries v=1 of the same point.
 * roads.ts uses that to sample the ground gradient once per pair rather than
 * once per vertex.
 */
export function addRibbon(s: RibbonScratch, pts: ArrayLike<number>, widthM: number): number {
  const h = widthM * 0.5;
  if (!(h > 0)) return 0;

  // Collapse repeated points first, so every segment below has a direction.
  const px: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i];
    const z = pts[i + 1];
    const last = px.length - 1;
    if (last >= 0 && Math.abs(x - px[last]) < DUP_EPS_M && Math.abs(z - pz[last]) < DUP_EPS_M) continue;
    px.push(x);
    pz.push(z);
  }
  const n = px.length;
  if (n < 2) return 0;

  // Per-segment unit direction, unit left normal, and the running arc length.
  //
  // The normal is (dz, -dx): the side that gets v=0. Which side that is does not
  // matter to the shader (it is symmetric in v about 0.5 except for the paint,
  // which is symmetric too), but it must be the SAME side for every vertex of
  // every road, or the wheel tracks and edge lines swap sides mid-block.
  const segCount = n - 1;
  const dirX = new Float64Array(segCount);
  const dirZ = new Float64Array(segCount);
  const nrmX = new Float64Array(segCount);
  const nrmZ = new Float64Array(segCount);
  const arc = new Float64Array(n);
  for (let i = 0; i < segCount; i++) {
    const dx = px[i + 1] - px[i];
    const dz = pz[i + 1] - pz[i];
    const len = Math.hypot(dx, dz);
    dirX[i] = dx / len;
    dirZ[i] = dz / len;
    nrmX[i] = dirZ[i];
    nrmZ[i] = -dirX[i];
    arc[i + 1] = arc[i] + len;
  }

  const base = s.xz.length / 2;
  let pairs = 0;
  const emit = (x: number, z: number, u: number, ox: number, oz: number): void => {
    s.xz.push(x + ox, z + oz);
    s.uv.push(u, 0);
    s.xz.push(x - ox, z - oz);
    s.uv.push(u, 1);
    pairs++;
  };

  emit(px[0], pz[0], arc[0], nrmX[0] * h, nrmZ[0] * h);

  for (let i = 1; i < n - 1; i++) {
    const a = i - 1;
    const b = i;
    let mx = nrmX[a] + nrmX[b];
    let mz = nrmZ[a] + nrmZ[b];
    const ml = Math.hypot(mx, mz);
    // ml is 2*cos(phi/2) for a turn of phi, so it collapses to zero exactly
    // when the way reverses on itself and there is no bisector to mitre along.
    const scale = ml > 1e-9 ? 2 / ml : Infinity;
    if (scale <= MITRE_LIMIT) {
      mx /= ml;
      mz /= ml;
      emit(px[i], pz[i], arc[i], mx * h * scale, mz * h * scale);
    } else {
      // Bevel. Two pairs at the same point and the same u, so the quad between
      // them has zero length along the road: it is exactly the wedge that fills
      // the outer corner, and it stretches no marking because u does not move.
      emit(px[i], pz[i], arc[i], nrmX[a] * h, nrmZ[a] * h);
      emit(px[i], pz[i], arc[i], nrmX[b] * h, nrmZ[b] * h);
    }
  }

  const last = segCount - 1;
  emit(px[n - 1], pz[n - 1], arc[n - 1], nrmX[last] * h, nrmZ[last] * h);

  let tris = 0;
  for (let k = 0; k + 1 < pairs; k++) {
    const a = base + k * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    s.idx.push(a, c, b, b, c, d);
    tris += 2;
  }
  return tris;
}
