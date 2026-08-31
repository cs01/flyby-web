// Car bodies, LOFTED FROM PUBLISHED DIMENSIONS at load time.
//
// NO ASSETS, AND THAT IS NOT A COMPROMISE HERE. This repo has no asset
// pipeline and docs/roadmap.md says why it is not getting one. For cars the
// argument is stronger than for anything else in the scene: every real make and
// model is a registered design, correctly licensed models of them do not exist
// at a price a browser toy can pay, and the rips that circulate are exactly the
// thing not to ship.
//
// BUT DIMENSIONS ARE NOT A DESIGN. Overall length, width, height, wheelbase,
// overhangs, track and tyre size are published measurements, and the previous
// version of this file did not use them: its numbers were invented to look
// about right, and the result was four boxes that read as a 1990s console game
// however good the lighting on them got. The figures below are the nominal
// published ones for four ordinary segments -- a mid-size saloon, a compact
// hatchback, a short-wheelbase panel van and a mid-size pickup -- rounded to
// the millimetre they are quoted at. They are a SEGMENT, not a model: what
// matters is that a car parked at a kerb is 4.9 m long and 1.44 m tall rather
// than whatever looked right, because everything around it is real size.
//
// HOW THE BODY IS BUILT. Not from boxes. Three polylines describe the vehicle
// the way a package drawing does:
//
//   topLine     the upper silhouette in side view: boot deck, backlight base,
//               roof, windscreen base, bonnet, nose.
//   bottomLine  the lower silhouette: the valance, the sill, and the WHEEL
//               ARCHES, which are simply where this line rises.
//   planLine    half width along the car, so the nose and tail draw in.
//
// A cross-section is swept along them and the surface is lofted between
// stations. That is what makes the shape read as a car: the silhouette is a
// curve, the flanks are continuous, and the shading normals come from the
// surface itself instead of being a flat value per quad.
//
// The parts carry an id rather than a material, so one draw call paints body,
// glass, wheels and lamps: `aPart` is read by the fragment shader in
// render/traffic.ts, which is also where the per-instance colour arrives. The
// id is interpolated FLAT, so a triangle is never half glass.
//
// LOCAL FRAME. +x is the direction the car faces, +y is up, +z is its right
// hand side, and the origin is on the ground between the wheels. That matches
// instanceToWorld in render/instanced.ts, which maps local +x to the instance
// yaw, so a car's heading is its yaw and nothing has to rotate anything twice.

/** Part ids, as the fragment shader reads them out of `aPart`. */
export const PART_BODY = 0;
export const PART_GLASS = 1;
export const PART_HEADLIGHT = 2;
export const PART_TAILLIGHT = 3;
export const PART_WHEEL = 4;
/** Everything seen THROUGH a wheel arch: the inner tub. Its own id rather than
 *  a dark body panel, because the shader draws a rim on a wheel and must not
 *  draw one on the tub behind it. */
export const PART_UNDER = 5;
/** The number plate. Four triangles, and one of the strongest cues there is
 *  that a shape is a road vehicle rather than a box on wheels. */
export const PART_PLATE = 6;

/** (station along the car, value). Station is 0 at the tail, 1 at the nose. */
export type Profile = readonly (readonly [number, number])[];

export interface CarArchetype {
  name: string;
  /** Published overall dimensions, in metres. */
  lengthM: number;
  widthM: number;
  heightM: number;
  wheelbaseM: number;
  /** Published front overhang; the rear is length minus wheelbase minus this. */
  frontOverhangM: number;
  /** Wheel centre separation across an axle. */
  trackM: number;
  /** Rolling radius from the quoted tyre size, and the tread width. */
  wheelR: number;
  tyreW: number;
  /** Upper silhouette in side view, in metres above the road. */
  topLine: Profile;
  /** Lower silhouette. Where this RISES, there is a wheel arch. */
  bottomLine: Profile;
  /** Half width as a fraction of half the overall width. */
  planLine: Profile;
  /** Beltline: the height at which glass takes over from sheet metal. */
  beltM: number;
  /** Stations between which the vehicle is GLAZED above the beltline. A van's
   *  cab glass stops a metre and a half from its back doors, and getting this
   *  wrong is what once made every van a five-metre black glass brick. */
  glassFrom: number;
  glassTo: number;
}

/**
 * The four segments.
 *
 * Figures are the nominal published ones for each class. Where a spec sheet
 * quotes a range (roof height with and without rails, tyre by trim) the
 * commonest fitment is taken. Tyre radii are computed from the quoted section:
 * a 235/45R18 is 18 x 25.4 + 2 x 235 x 0.45 = 668 mm across, so 0.334 m.
 */
export const CAR_ARCHETYPES: readonly CarArchetype[] = [
  {
    // Mid-size saloon, Camry/Accord class. 235/45R18.
    name: "saloon",
    lengthM: 4.885, widthM: 1.840, heightM: 1.445,
    wheelbaseM: 2.825, frontOverhangM: 1.000, trackM: 1.590,
    wheelR: 0.334, tyreW: 0.235,
    topLine: [
      [0.00, 0.80], [0.04, 1.00], [0.12, 1.055], [0.26, 1.09],
      [0.33, 1.16], [0.47, 1.40], [0.56, 1.443], [0.66, 1.445],
      [0.72, 1.40], [0.79, 1.19], [0.86, 1.06], [0.94, 1.02],
      [0.98, 0.98], [1.00, 0.84],
    ],
    bottomLine: [
      [0.00, 0.46], [0.04, 0.30], [0.10, 0.245],
      [0.122, 0.245], [0.134, 0.50], [0.217, 0.52], [0.300, 0.50], [0.312, 0.245],
      [0.700, 0.245], [0.712, 0.50], [0.795, 0.52], [0.878, 0.50], [0.890, 0.245],
      [0.95, 0.30], [1.00, 0.46],
    ],
    planLine: [
      [0.00, 0.78], [0.04, 0.92], [0.14, 0.99], [0.30, 1.00],
      [0.70, 1.00], [0.86, 0.97], [0.95, 0.88], [1.00, 0.72],
    ],
    beltM: 1.00, glassFrom: 0.33, glassTo: 0.79,
  },
  {
    // Compact hatchback, Golf class. 205/55R16.
    name: "hatch",
    lengthM: 4.284, widthM: 1.789, heightM: 1.456,
    wheelbaseM: 2.636, frontOverhangM: 0.865, trackM: 1.540,
    wheelR: 0.315, tyreW: 0.205,
    topLine: [
      [0.00, 0.92], [0.03, 1.20], [0.09, 1.36], [0.18, 1.43],
      [0.30, 1.452], [0.50, 1.456], [0.62, 1.44], [0.70, 1.36],
      [0.78, 1.16], [0.86, 1.02], [0.94, 0.98], [0.98, 0.94], [1.00, 0.80],
    ],
    bottomLine: [
      [0.00, 0.44], [0.03, 0.29], [0.08, 0.235],
      [0.078, 0.235], [0.090, 0.48], [0.183, 0.50], [0.276, 0.48], [0.288, 0.235],
      [0.694, 0.235], [0.706, 0.48], [0.798, 0.50], [0.890, 0.48], [0.902, 0.235],
      [0.95, 0.29], [1.00, 0.44],
    ],
    planLine: [
      [0.00, 0.85], [0.05, 0.95], [0.16, 1.00], [0.32, 1.00],
      [0.70, 1.00], [0.86, 0.97], [0.95, 0.87], [1.00, 0.70],
    ],
    beltM: 0.97, glassFrom: 0.14, glassTo: 0.78,
  },
  {
    // Short-wheelbase panel van, Transit Custom class. 215/65R16.
    name: "van",
    lengthM: 4.972, widthM: 1.986, heightM: 1.925,
    wheelbaseM: 2.933, frontOverhangM: 0.935, trackM: 1.628,
    wheelR: 0.343, tyreW: 0.215,
    topLine: [
      [0.00, 1.86], [0.02, 1.920], [0.55, 1.925], [0.78, 1.920],
      [0.84, 1.86], [0.89, 1.62], [0.94, 1.28], [0.975, 1.10], [1.00, 0.96],
    ],
    bottomLine: [
      [0.00, 0.48], [0.03, 0.32], [0.09, 0.28],
      [0.128, 0.28], [0.140, 0.50], [0.222, 0.53], [0.304, 0.50], [0.316, 0.28],
      [0.718, 0.28], [0.730, 0.50], [0.812, 0.53], [0.894, 0.50], [0.906, 0.28],
      [0.96, 0.34], [1.00, 0.50],
    ],
    planLine: [
      [0.00, 0.94], [0.04, 0.99], [0.12, 1.00], [0.80, 1.00],
      [0.90, 0.98], [0.96, 0.90], [1.00, 0.76],
    ],
    beltM: 1.20, glassFrom: 0.76, glassTo: 0.95,
  },
  {
    // Mid-size pickup, Tacoma/Ranger class. 265/65R17.
    name: "pickup",
    lengthM: 5.393, widthM: 1.900, heightM: 1.798,
    wheelbaseM: 3.235, frontOverhangM: 0.905, trackM: 1.605,
    wheelR: 0.388, tyreW: 0.265,
    topLine: [
      [0.00, 1.12], [0.06, 1.15], [0.34, 1.15], [0.37, 1.22],
      [0.40, 1.62], [0.50, 1.78], [0.60, 1.798], [0.68, 1.77],
      [0.74, 1.55], [0.80, 1.33], [0.88, 1.28], [0.95, 1.24], [1.00, 1.08],
    ],
    bottomLine: [
      [0.00, 0.56], [0.03, 0.40], [0.10, 0.345],
      [0.138, 0.345], [0.150, 0.56], [0.232, 0.60], [0.314, 0.56], [0.326, 0.345],
      [0.738, 0.345], [0.750, 0.56], [0.832, 0.60], [0.914, 0.56], [0.926, 0.345],
      [0.96, 0.40], [1.00, 0.56],
    ],
    planLine: [
      [0.00, 0.92], [0.05, 0.99], [0.14, 1.00], [0.80, 1.00],
      [0.90, 0.98], [0.96, 0.90], [1.00, 0.76],
    ],
    beltM: 1.22, glassFrom: 0.40, glassTo: 0.80,
  },
];

export interface CarMesh {
  position: Float32Array;
  normal: Float32Array;
  /**
   * Where a fragment is ON ITS OWN PART, and what the part needs to know about
   * the car it belongs to. Four components:
   *
   *   x  part id, as PART_* above. Interpolated FLAT by the shader, so a
   *      triangle is never half glass and half metal.
   *   y  0..1 along the part. For a body panel that is the station along the
   *      whole car; for the greenhouse it is 1 at the WINDSCREEN and 0 where
   *      the glazing ends, so the shader finds the A and C posts without being
   *      told where the cabin is.
   *   z  0..1 up the part, in units the shader can use without knowing the
   *      archetype: WHEEL DIAMETERS for a body panel, so one set of constants
   *      fits a hatchback and a van; the glazing's own height for the cabin,
   *      so the rubber seal is always at 0. On a WHEEL it is the radius as a
   *      fraction of the tyre, which is all the shader needs to draw a tyre
   *      wall, a bead lip and a hub.
   *   w  the beltline height, in the same wheel diameters as z. That is what
   *      lets the shader put the shoulder crease and the door shuts on the
   *      right line of a body whose proportions it does not otherwise know.
   */
  aPart: Float32Array;
  index: Uint16Array;
  triangles: number;
}

/**
 * Detail levels.
 *
 * LOD_SHADOW is the one that matters most for the frame time, and that is not
 * obvious: a car is drawn FIVE times a frame -- once for the picture, three
 * times into the sun's shadow cascades and once into the ambient-occlusion
 * depth prepass -- so four fifths of every triangle on it is spent on a
 * proxy. Giving the casters their own body is worth more than any reduction to
 * the one you actually look at.
 *
 * BUT IT KEEPS THE SECTION. A caster with fewer section rows has a different
 * SILHOUETTE from the body it stands in for, so the roof of the real car falls
 * outside its own shadow and lights up -- with the proxy's faceting printed
 * across it as a row of triangular teeth. That is what a car shadowing itself
 * against a proxy of the wrong shape looks like, and it is not subtle. The
 * saving here is in stations and in wheel facets, never in the section.
 */
export const LOD_NEAR = 0;
export const LOD_FAR = 1;
export const LOD_SHADOW = 2;

interface Builder {
  pos: number[];
  nrm: number[];
  part: number[];
  idx: number[];
}

/** Linear interpolation along a profile, clamped at both ends. */
export function sampleProfile(p: Profile, s: number): number {
  if (s <= p[0][0]) return p[0][1];
  const last = p[p.length - 1];
  if (s >= last[0]) return last[1];
  for (let i = 1; i < p.length; i++) {
    if (s <= p[i][0]) {
      const [x0, y0] = p[i - 1];
      const [x1, y1] = p[i];
      const t = x1 === x0 ? 0 : (s - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return last[1];
}

/**
 * The cross-section, as a half: outer sill, round the flank, up over the
 * shoulder and in to the roof edge.
 *
 * ONE SHAPE, SCALED BY EACH STATION'S OWN TOP AND BOTTOM. A station on the
 * bonnet is short and a station at the B post is tall, so the same normalised
 * curve gives a bonnet that crowns gently and a greenhouse that tumbles home,
 * which is what those two things actually do.
 *
 * Row 3 is the BELTLINE and is emitted twice, once tagged metal and once
 * tagged glass. A duplicated row costs no triangles and is what makes the
 * transition a line rather than a gradient.
 */
const SECTION: readonly { v: number; w: number }[] = [
  { v: 0.00, w: 0.90 }, // sill, tucked under
  { v: 0.34, w: 1.00 }, // widest point
  { v: 0.74, w: 0.995 },
  { v: 1.00, w: 0.965 }, // the beltline
  { v: 0.42, w: 0.895 }, // above the belt: tumblehome
  { v: 0.78, w: 0.790 },
  { v: 0.94, w: 0.660 }, // the roof rail, turning over
  { v: 1.00, w: 0.430 }, // roof edge
  { v: 1.00, w: 0.000 }, // the CROWN, on the centreline
];
const BELT_ROW = 3;
/** The crown row sits on z = 0 and is SHARED by both sides. A separate flat
 *  strip across the top instead of a real row is what put a sawtooth of blown
 *  highlights down the roof: one wide quad spanning the whole car is not
 *  planar between stations, so its two triangles disagree, and a clearcoat
 *  lobe finds that difference immediately. */


/** How many section rows a level of detail keeps. */
function sectionRows(lod: number): number[] {
  if (lod === LOD_NEAR) return [0, 1, 2, 3, 4, 5, 6, 7, 8];
  if (lod === LOD_FAR) return [0, 1, 3, 4, 6, 7, 8];
  return [0, 1, 3, 4, 6, 7, 8];
}

/**
 * Stations to loft through.
 *
 * The union of every profile's own stations, because those are exactly where
 * the shape has features: a station set chosen on a regular grid would round
 * off the boot lip and the cowl, which are the two creases that most say
 * "saloon". Merged within a tolerance so three coincident points do not
 * produce two zero-length spans.
 */
function stationsFor(a: CarArchetype, lod: number): number[] {
  // The glazing's own ends are stations whatever else is dropped: the shader
  // finds the A post at u = 1 and the C post at u = 0, and it can only do that
  // if a vertex actually lands on each.
  const all = [
    ...a.topLine.map((p) => p[0]),
    ...a.bottomLine.map((p) => p[0]),
    ...a.planLine.map((p) => p[0]),
  ].sort((x, y) => x - y);
  const out: number[] = [];
  // A coarse level keeps the arch edges and the ends and drops the rest, since
  // at the distance it is drawn the creases are under a pixel.
  const minGap = lod === LOD_NEAR ? 0.030 : lod === LOD_FAR ? 0.045 : 0.11;
  for (const s of all) {
    if (!out.length || s - out[out.length - 1] > minGap) out.push(s);
  }
  if (out[0] > 0) out.unshift(0);
  if (out[out.length - 1] < 1) out.push(1);
  for (const s of [a.glassFrom, a.glassTo]) {
    if (!out.some((o) => Math.abs(o - s) < 1e-6)) out.push(s);
  }
  out.sort((x, y) => x - y);
  return out;
}

/** Where the surface is, for one station and one section row. */
interface Vertex {
  x: number;
  y: number;
  z: number;
  part: number;
  u: number;
  v: number;
}

function buildGrid(a: CarArchetype, lod: number): { grid: Vertex[][]; stations: number[] } {
  const stations = stationsFor(a, lod);
  const rows = sectionRows(lod);
  const hw = a.widthM * 0.5;
  const wheelD = a.wheelR * 2;
  const glazedLen = Math.max(a.glassTo - a.glassFrom, 1e-3);
  const grid: Vertex[][] = [];

  for (const s of stations) {
    const bottom = sampleProfile(a.bottomLine, s);
    const top = Math.max(sampleProfile(a.topLine, s), bottom + 0.02);
    const halfW = hw * sampleProfile(a.planLine, s);
    // Where the beltline falls in this station's own height. A station whose
    // roof is below the belt -- a bonnet, a boot deck, a load bed -- has no
    // greenhouse at all, and its upper rows collapse onto its top edge.
    const vb = Math.min(1, Math.max(0, (a.beltM - bottom) / (top - bottom)));
    const glazed = s >= a.glassFrom && s <= a.glassTo && vb < 0.999;
    const col: Vertex[] = [];
    for (const r of rows) {
      const sec = SECTION[r];
      const above = r > BELT_ROW;
      const v = above ? vb + sec.v * (1 - vb) : sec.v * vb;
      const y = bottom + (top - bottom) * v;
      const part = above && glazed ? PART_GLASS : PART_BODY;
      col.push({
        x: (s - 0.5) * a.lengthM,
        y,
        z: halfW * sec.w,
        part,
        // Along the part: the whole car for metal, the glazed run for glass,
        // measured so that 1 is the windscreen on every archetype.
        u: part === PART_GLASS ? (s - a.glassFrom) / glazedLen : s,
        // Up the part: wheel diameters for metal, the glazing's own height for
        // glass, so a rubber seal is always at zero.
        v: part === PART_GLASS
          ? Math.max(0, (v - vb) / Math.max(1 - vb, 1e-3))
          : y / wheelD,
      });
    }
    grid.push(col);
  }
  return { grid, stations };
}

/** True when the quad between rows r and r+1 over stations c and c+1 has no area. */
function degenerate(grid: Vertex[][], c: number, r: number): boolean {
  const h0 = Math.abs(grid[c][r + 1].y - grid[c][r].y) + Math.abs(grid[c][r + 1].z - grid[c][r].z);
  const h1 = Math.abs(grid[c + 1][r + 1].y - grid[c + 1][r].y)
           + Math.abs(grid[c + 1][r + 1].z - grid[c + 1][r].z);
  return h0 < 1e-5 && h1 < 1e-5;
}

function pushVertex(b: Builder, x: number, y: number, z: number, part: number, u: number, v: number, belt: number): number {
  const i = b.pos.length / 3;
  b.pos.push(x, y, z);
  b.nrm.push(0, 0, 0);
  b.part.push(part, u, v, belt);
  return i;
}

/**
 * Build one archetype at one level of detail.
 *
 * The surface normals are ACCUMULATED from the triangles that meet at each
 * vertex rather than assigned per face. That is the difference between a lofted
 * body and a faceted one: with a face normal, a whole flank reflects the sky at
 * a single angle and comes out one flat value, which no amount of material work
 * can rescue.
 *
 * The seam rows at the beltline are duplicated and therefore keep hard normals
 * across the crease, which is correct -- a beltline IS a crease.
 */
export function buildCarMesh(archetype: number, lod: number = LOD_NEAR): CarMesh {
  const a = CAR_ARCHETYPES[archetype];
  const b: Builder = { pos: [], nrm: [], part: [], idx: [] };
  const { grid } = buildGrid(a, lod);
  const rows = sectionRows(lod).length;
  const cols = grid.length;
  const wheelD = a.wheelR * 2;
  const beltV = a.beltM / wheelD;
  const L = a.lengthM;
  const nose = L * 0.5;
  const tail = -L * 0.5;

  // Both flanks. `side` is the sign of z; the winding flips with it so every
  // triangle faces out of the body.
  const id: number[][][] = [[], []];
  for (let side = 0; side < 2; side++) {
    const sgn = side === 0 ? 1 : -1;
    for (let c = 0; c < cols; c++) {
      const colIds: number[] = [];
      for (let r = 0; r < rows; r++) {
        const g = grid[c][r];
        // The crown is on the centreline, so the two sides are the same vertex.
        // Emitting it twice would put a seam of averaged-apart normals straight
        // down the middle of every roof and bonnet.
        if (side === 1 && Math.abs(g.z) < 1e-9) colIds.push(id[0][c][r]);
        else colIds.push(pushVertex(b, g.x, g.y, sgn * g.z, g.part, g.u, g.v, beltV));
      }
      id[side].push(colIds);
    }
  }

  const tri = (i0: number, i1: number, i2: number): void => { b.idx.push(i0, i1, i2); };
  const quad = (i0: number, i1: number, i2: number, i3: number): void => {
    tri(i0, i1, i2);
    tri(i0, i2, i3);
  };

  for (let side = 0; side < 2; side++) {
    const ids = id[side];
    for (let c = 0; c + 1 < cols; c++) {
      for (let r = 0; r + 1 < rows; r++) {
        // A collapsed row pair is a zero-area quad: at a station whose roof is
        // below the beltline -- a bonnet, a boot deck, a load bed -- there is
        // no greenhouse and its rows all sit on the top edge. Emitting those
        // costs triangles that draw nothing and have no winding to check.
        if (degenerate(grid, c, r)) continue;
        const a0 = ids[c][r];
        const a1 = ids[c + 1][r];
        const a2 = ids[c + 1][r + 1];
        const a3 = ids[c][r + 1];
        if (side === 0) quad(a0, a1, a2, a3);
        else quad(a0, a3, a2, a1);
      }
    }
  }

  // The underside. Never seen from outside, but it closes the body for the
  // depth prepass, which needs a solid. Dropped at the coarse level: a car
  // drawn at that level is never between the camera and anything, and the sun
  // is above it.
  if (lod === LOD_NEAR) {
    for (let c = 0; c + 1 < cols; c++) {
      quad(id[1][c][0], id[1][c + 1][0], id[0][c + 1][0], id[0][c][0]);
    }
  }
  /**
   * Emit a triangle wound so its geometric normal points along `wantX`.
   *
   * The end caps are fans about a hub, and a fan's winding is NOT constant if
   * you reason about it row by row: the sign of the cross product flips as the
   * ring crosses the hub's own height, so half of each cap came out inside
   * out. Worse than the hole that leaves, the wrongly-wound triangles then
   * poisoned the SMOOTH NORMALS of every ring vertex they touched, which put
   * the whole tail station's shading back to front. Deciding the winding from
   * the triangle itself is both shorter and not a thing to get wrong twice.
   */
  const triFacing = (i0: number, i1: number, i2: number, wantX: number): void => {
    const ay = b.pos[i1 * 3 + 1] - b.pos[i0 * 3 + 1];
    const az = b.pos[i1 * 3 + 2] - b.pos[i0 * 3 + 2];
    const by = b.pos[i2 * 3 + 1] - b.pos[i0 * 3 + 1];
    const bz = b.pos[i2 * 3 + 2] - b.pos[i0 * 3 + 2];
    const gx = ay * bz - az * by;
    if (gx * wantX < 0) tri(i0, i2, i1);
    else tri(i0, i1, i2);
  };

  // The two ends, as fans about the section's own middle.
  for (const [c, outward] of [[0, -1], [cols - 1, 1]] as [number, number][]) {
    let cy = 0;
    for (let r = 0; r < rows; r++) cy += grid[c][r].y;
    cy /= rows;
    const hub = pushVertex(b, grid[c][0].x, cy, 0, PART_BODY, grid[c][0].u, cy / wheelD, beltV);
    for (let r = 0; r + 1 < rows; r++) {
      const g0 = grid[c][r];
      const g1 = grid[c][r + 1];
      if (Math.abs(g1.y - g0.y) + Math.abs(g1.z - g0.z) < 1e-5) continue;
      triFacing(hub, id[0][c][r], id[0][c][r + 1], outward);
      triFacing(hub, id[1][c][r], id[1][c][r + 1], outward);
    }
    // Close the fan under the floor. NOT over the crown: that row is on the
    // centreline and shared between the sides, so the two ends of the ring are
    // the same vertex and the closing triangle has no area.
    triFacing(hub, id[0][c][0], id[1][c][0], outward);
  }

  // Smooth normals, accumulated by triangle area so a long thin triangle does
  // not outvote a square one.
  for (let t = 0; t < b.idx.length; t += 3) {
    const i0 = b.idx[t];
    const i1 = b.idx[t + 1];
    const i2 = b.idx[t + 2];
    const ax = b.pos[i1 * 3] - b.pos[i0 * 3];
    const ay = b.pos[i1 * 3 + 1] - b.pos[i0 * 3 + 1];
    const az = b.pos[i1 * 3 + 2] - b.pos[i0 * 3 + 2];
    const bx = b.pos[i2 * 3] - b.pos[i0 * 3];
    const by = b.pos[i2 * 3 + 1] - b.pos[i0 * 3 + 1];
    const bz = b.pos[i2 * 3 + 2] - b.pos[i0 * 3 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    for (const i of [i0, i1, i2]) {
      b.nrm[i * 3] += nx;
      b.nrm[i * 3 + 1] += ny;
      b.nrm[i * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < b.nrm.length; i += 3) {
    const l = Math.hypot(b.nrm[i], b.nrm[i + 1], b.nrm[i + 2]);
    if (l > 1e-9) {
      b.nrm[i] /= l;
      b.nrm[i + 1] /= l;
      b.nrm[i + 2] /= l;
    } else {
      b.nrm[i + 1] = 1;
    }
  }

  // --- everything that is not the lofted shell ------------------------------
  const flat = (x: number, y: number, z: number, n: number[], part: number, u: number, v: number): number => {
    const i = pushVertex(b, x, y, z, part, u, v, beltV);
    b.nrm[i * 3] = n[0];
    b.nrm[i * 3 + 1] = n[1];
    b.nrm[i * 3 + 2] = n[2];
    return i;
  };
  const flatQuad = (c: number[], n: number[], part: number, uv: number[]): void => {
    const base = b.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      flat(c[i * 3], c[i * 3 + 1], c[i * 3 + 2], n, part, uv[i * 2], uv[i * 2 + 1]);
    }
    quad(base, base + 1, base + 2, base + 3);
  };

  // Everything below is detail rather than silhouette, and a shadow caster is
  // only ever a silhouette.
  if (lod !== LOD_SHADOW) {
  // The inner tub: what is seen THROUGH an arch. Two panels, because the other
  // four faces of it are inside the car.
  const tubZ = a.trackM * 0.5 - a.tyreW * 0.5 - 0.02;
  const tubTop = a.beltM * 0.92;
  const tubBottom = a.wheelR * 0.20;
  for (const sgn of [1, -1]) {
    const z = sgn * tubZ;
    const c = sgn > 0
      ? [nose - 0.10, tubBottom, z, nose - 0.10, tubTop, z, tail + 0.10, tubTop, z, tail + 0.10, tubBottom, z]
      : [tail + 0.10, tubBottom, z, tail + 0.10, tubTop, z, nose - 0.10, tubTop, z, nose - 0.10, tubBottom, z];
    flatQuad(c, [0, 0, sgn], PART_UNDER, [0, 0, 0, 1, 1, 1, 1, 0]);
  }

  }

  // The wheels, at the published track and wheelbase.
  const axleF = nose - a.frontOverhangM;
  const axleR = axleF - a.wheelbaseM;
  const wheelSides = lod === LOD_NEAR ? 10 : lod === LOD_FAR ? 8 : 4;
  for (const ax of [axleF, axleR]) {
    for (const sgn of [1, -1]) {
      addWheel(b, flat, quad, tri, ax, sgn * a.trackM * 0.5, a.wheelR, a.tyreW * 0.5, wheelSides, beltV);
    }
  }

  if (lod === LOD_SHADOW) {
    return {
      position: new Float32Array(b.pos),
      normal: new Float32Array(b.nrm),
      aPart: new Float32Array(b.part),
      index: new Uint16Array(b.idx),
      triangles: b.idx.length / 3,
    };
  }

  // The number plate, four triangles standing 12 mm off each end. Out of all
  // proportion to its size: a bright rectangle low on a dark end is one of the
  // few marks the eye reads as "road vehicle" with nothing else to go on.
  const plateHalfW = Math.min(0.26, a.widthM * 0.15);
  const plateY0 = a.beltM * 0.26;
  const plateY1 = plateY0 + 0.115;
  for (const [px, dir] of [[nose - 0.02, 1], [tail + 0.02, -1]] as [number, number][]) {
    const c = dir > 0
      ? [px, plateY0, -plateHalfW, px, plateY1, -plateHalfW, px, plateY1, plateHalfW, px, plateY0, plateHalfW]
      : [px, plateY0, plateHalfW, px, plateY1, plateHalfW, px, plateY1, -plateHalfW, px, plateY0, -plateHalfW];
    flatQuad(c, [dir, 0, 0], PART_PLATE, [0, 0, 0, 1, 1, 1, 1, 0]);
  }

  // Lamp lenses, at the height a real cluster sits and standing proud of the
  // end they are on so they cannot z-fight with it.
  const hw = a.widthM * 0.5;
  const lensY0 = a.beltM * 0.55;
  const lensY1 = lensY0 + 0.19;
  for (const sgn of [1, -1]) {
    const z0 = sgn > 0 ? hw * 0.40 : -hw * 0.86;
    const z1 = sgn > 0 ? hw * 0.86 : -hw * 0.40;
    const fx = nose - 0.05;
    flatQuad([fx, lensY0, z0, fx, lensY1, z0, fx, lensY1, z1, fx, lensY0, z1],
      [1, 0, 0], PART_HEADLIGHT, [0, 0, 0, 1, 1, 1, 1, 0]);
    const rx = tail + 0.05;
    flatQuad([rx, lensY0, z1, rx, lensY1, z1, rx, lensY1, z0, rx, lensY0, z0],
      [-1, 0, 0], PART_TAILLIGHT, [0, 0, 0, 1, 1, 1, 1, 0]);
  }

  return {
    position: new Float32Array(b.pos),
    normal: new Float32Array(b.nrm),
    aPart: new Float32Array(b.part),
    index: new Uint16Array(b.idx),
    triangles: b.idx.length / 3,
  };
}

/**
 * One road wheel, as an n-sided prism about the z axis.
 *
 * SIZED BY ITS FLAT, not by its circumradius. A polygon inscribed in the wheel
 * radius stands on a vertex and leaves the tyre several centimetres off the
 * road; one circumscribed about it touches along a flat, which is what a
 * loaded tyre does anyway.
 *
 * The OUTBOARD face is a fan and the inboard one is not: the inboard face lives
 * inside the arch and is back-facing from everywhere outside the car. On that
 * fan, `v` is the radius as a fraction of the tyre, which is the whole of what
 * the shader needs to draw a tyre wall, a bead lip and a hub with no angle, no
 * texture and no second part id.
 */
function addWheel(
  b: Builder,
  flat: (x: number, y: number, z: number, n: number[], part: number, u: number, v: number) => number,
  quad: (i0: number, i1: number, i2: number, i3: number) => void,
  tri: (i0: number, i1: number, i2: number) => void,
  cx: number, cz: number, wheelR: number, halfThick: number, sides: number,
  beltV: number,
): void {
  void beltV;
  const r = wheelR / Math.cos(Math.PI / sides);
  const cy = wheelR;
  const out = cz > 0 ? 1 : -1;
  const z0 = cz - halfThick;
  const z1 = cz + halfThick;
  const zOut = out > 0 ? z1 : z0;
  // A flat at the bottom: the first vertex sits half a step off the -y axis.
  const ang = (k: number): number => (2 * Math.PI * (k + 0.5)) / sides - Math.PI / 2;
  const px = (k: number): number => cx + r * Math.cos(ang(k));
  const py = (k: number): number => cy + r * Math.sin(ang(k));

  for (let k = 0; k < sides; k++) {
    const x0 = px(k);
    const y0 = py(k);
    const x1 = px(k + 1);
    const y1 = py(k + 1);
    // The tread faces radially outward on both wheels of an axle, so its
    // winding does not depend on which side the wheel is.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dl = Math.hypot(dx, dy) || 1;
    const n = [dy / dl, -dx / dl, 0];
    const base = b.pos.length / 3;
    flat(x0, y0, z0, n, PART_WHEEL, 0.5, 1);
    flat(x1, y1, z0, n, PART_WHEEL, 0.5, 1);
    flat(x1, y1, z1, n, PART_WHEEL, 0.5, 1);
    flat(x0, y0, z1, n, PART_WHEEL, 0.5, 1);
    quad(base, base + 1, base + 2, base + 3);
  }
  const nOut = [0, 0, out];
  for (let k = 0; k < sides; k++) {
    const ring: [number, number][] = [[px(k), py(k)], [px(k + 1), py(k + 1)]];
    const pts: [number, number][] = out > 0
      ? [[cx, cy], ring[0], ring[1]]
      : [[cx, cy], ring[1], ring[0]];
    const base = b.pos.length / 3;
    for (const [x, y] of pts) {
      flat(x, y, zOut, nOut, PART_WHEEL, 0.5, Math.hypot(x - cx, y - cy) / wheelR);
    }
    tri(base, base + 1, base + 2);
  }
}

/** Triangles in each archetype at each level, for the frame budget. */
export const CAR_TRIANGLES: readonly number[] = CAR_ARCHETYPES.map(
  (_a, i) => buildCarMesh(i, LOD_FAR).triangles,
);
export const CAR_TRIANGLES_NEAR: readonly number[] = CAR_ARCHETYPES.map(
  (_a, i) => buildCarMesh(i, LOD_NEAR).triangles,
);
export const CAR_TRIANGLES_SHADOW: readonly number[] = CAR_ARCHETYPES.map(
  (_a, i) => buildCarMesh(i, LOD_SHADOW).triangles,
);
