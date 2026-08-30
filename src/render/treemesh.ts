// What a tree is SHAPED like: one continuous shape function, sampled at three
// resolutions, for two silhouettes.
//
// WHY THIS IS A SEPARATE, PURE FILE. The old crown was a six-sided ring built
// inline in the renderer, and the only way to judge it was to look at it. Every
// property that actually decides whether a canopy reads as trees or as green
// prisms is arithmetic on the mesh -- how ragged the outline is, whether the
// coarse tree is the same SIZE as the near one, how many triangles each level
// costs -- so the shape lives here with no THREE and no GL, and
// test/trees.check.ts measures it under Bun. src/render/trees.ts is the half
// that owns buffers, shaders and instances.
//
// THREE IDEAS CARRY THE WHOLE FILE.
//
// **One shape function, sampled three ways.** A crown is `radius(theta, t)`:
// a profile table down the axis times an angular lobe sum. A level of detail is
// that same function sampled at fewer angles and fewer rings, PREFILTERED over
// the cell it is about to stand for. Prefiltering is what makes the levels
// agree: a lobe the coarse mesh cannot resolve is averaged away rather than
// point-sampled into an arbitrary bulge, and a harmonic that lands exactly on
// the coarse mesh's sample count (cos 7 theta on a seven-sided ring, which
// would otherwise become a constant radial offset) integrates to nothing.
//
// **The outline is ragged in the GEOMETRY, not in a texture.** There are no
// texture assets in this project and there is not going to be a texture
// pipeline (docs/roadmap.md says why), so the notches and gaps that make a
// crown read as foliage have to be vertices. That is affordable here and
// almost nowhere else: measured on this renderer, 1.4M triangles of skyline
// costs ~0.26 ms while the per-fragment atmosphere march costs ~5 ms, so
// geometry is the spare resource and the crown is allowed to be extravagant
// with it.
//
// **Coarse levels are volume-matched to the true shape.** An N-gon inscribed
// in a circle has less area than the circle by (N / 2pi) sin(2pi / N), which at
// seven sides is 10% -- so a naive coarse tree is visibly THINNER than the near
// one and the level switch pops. Each level is therefore scaled so its crown
// volume matches a high-resolution evaluation of the same shape function. The
// check gates the statistics that are NOT normalised this way (height, maximum
// and mean radius, silhouette width by azimuth), so it is measuring the
// agreement rather than restating the normalisation.
//
// The species split is INVENTED, and has to be. WorldCover measures how much of
// a 10 m texel is tree; it does not say broadleaf or conifer, and no open
// dataset at this resolution does. So the two silhouettes here are a plausible
// pair rather than a claim about the ground, and the mix (see TREE_SPECIES in
// src/data/trees.ts) is uniform rather than regional for the same reason: a
// regional mix would be a guess wearing the costume of a measurement.

const TAU = Math.PI * 2;

/** One angular harmonic of the crown outline. */
export interface CrownLobe {
  /** Harmonic number: how many bulges around the crown. */
  n: number;
  /** Amplitude as a fraction of the profile radius. */
  amp: number;
  /** Angular phase, radians. */
  phase: number;
  /** How far the bulge rotates between the bottom of the crown and the top.
   *  Non-zero on every lobe on purpose: lobes that do not twist extrude
   *  vertically and the crown reads as a fluted column. */
  twist: number;
}

export interface TreeFormDef {
  name: string;
  /** Height fraction where the crown starts. */
  crownBase: number;
  /** Height fraction where the trunk ends, just inside the crown. */
  trunkTop: number;
  /** Trunk radius at the ground and at the top, as fractions of crown radius. */
  trunkR0: number;
  trunkR1: number;
  /**
   * Crown radius against height, as a fraction of the crown's nominal radius,
   * over t = 0 (crown base) to t = 1 (apex). Read as a table with smoothstep
   * interpolation rather than as a formula, because the interesting parts are
   * the WAISTS and the TIERS -- a broadleaf pinched below its widest mass, a
   * conifer's branch whorls -- and those are easier to write down than to
   * express.
   */
  profile: readonly number[];
  lobes: readonly CrownLobe[];
}

/**
 * Two silhouettes, because a conifer and a broadleaf are different at a glance
 * from a kilometre away and no amount of leaf detail substitutes for that.
 *
 * They are separate meshes rather than one mesh morphed by an instance
 * attribute, which is what the previous version did. A morph can only move the
 * rings the base mesh already has, so the conifer got a taper and nothing else;
 * built separately, it gets its own whorl tiers, its own crown base low on the
 * trunk and its own lobe set. The cost is one more draw call per level, which
 * is nothing.
 */
export const TREE_FORMS: readonly TreeFormDef[] = [
  {
    name: "broadleaf",
    // The crown starts well up the trunk. It used to start at 0.30 with a
    // profile that was still 0.46 wide there, which put a ball of foliage on
    // the ground with no visible stem: from 55 m up a stand of them read as
    // mossy boulders rather than as trees.
    crownBase: 0.38,
    trunkTop: 0.48,
    trunkR0: 0.13,
    trunkR1: 0.075,
    // Widest a third of the way up, with a waist above it so the crown reads as
    // two masses rather than one dome, and a top that comes to a ragged point
    // rather than a cap.
    profile: [0.30, 0.70, 0.93, 1.00, 0.86, 0.96, 0.82, 0.61, 0.42, 0.16],
    lobes: [
      { n: 2, amp: 0.20, phase: 0.72, twist: 0.90 },
      { n: 3, amp: 0.22, phase: 2.10, twist: -1.40 },
      { n: 5, amp: 0.10, phase: 4.02, twist: 2.20 },
      { n: 7, amp: 0.06, phase: 1.24, twist: -2.80 },
    ],
  },
  {
    name: "conifer",
    crownBase: 0.14,
    trunkTop: 0.26,
    trunkR0: 0.20,
    trunkR1: 0.11,
    // A spire, and the zig-zag is the point: each pair of entries is one branch
    // whorl flaring out and tapering in again, which is the notched edge a
    // conifer has against the sky and a smooth cone does not.
    profile: [0.84, 1.00, 0.79, 0.90, 0.66, 0.76, 0.52, 0.60, 0.37, 0.43, 0.21, 0.25, 0.06],
    lobes: [
      { n: 3, amp: 0.10, phase: 1.50, twist: 1.10 },
      { n: 5, amp: 0.09, phase: 3.30, twist: -2.00 },
      { n: 8, amp: 0.06, phase: 0.40, twist: 3.00 },
    ],
  },
];

export const FORM_BROADLEAF = 0;
export const FORM_CONIFER = 1;

export interface TreeLodDef {
  name: string;
  /** Vertices around a crown ring. */
  sides: number;
  /** Crown rings between the skirt and the apex. */
  rings: number;
  /** Vertices around the trunk. */
  trunkSides: number;
  /**
   * Distance in metres out to which this level is used. The last level's is
   * Infinity; the field's own fade decides where trees stop entirely.
   *
   * These are generous rather than tight because the level of an instance is
   * chosen when the buffers are repacked, not per frame, so a tree can sit one
   * level finer than its exact distance for a few tens of metres of flight.
   * Paying for that in triangles is free here; paying for it in a visible
   * switch would not be.
   */
  farM: number;
}

/**
 * Three levels. The near one is what the low pass over Emerald Hills is judged
 * on; the far one is what 20,000 instances of a 55%-canopy suburb actually
 * costs.
 *
 * Side counts are 20 / 12 / 7 rather than a halving sequence because the
 * angular prefilter kills whatever a level cannot resolve, so the only thing
 * that matters is that each is coprime enough with the lobe harmonics that the
 * SURVIVING ones are still sampled somewhere near their peaks.
 */
export const TREE_LODS: readonly TreeLodDef[] = [
  { name: "near", sides: 20, rings: 11, trunkSides: 8, farM: 260 },
  { name: "mid", sides: 14, rings: 8, trunkSides: 5, farM: 800 },
  { name: "far", sides: 9, rings: 5, trunkSides: 4, farM: Infinity },
];

export interface TreeMesh {
  /** xyz, unit tree: 1 m tall, nominal crown radius 1 m, standing on y = 0. */
  position: Float32Array;
  normal: Float32Array;
  /**
   * Per-vertex vec4:
   *   x  1 on the crown, 0 on the trunk
   *   y  depth into the canopy, 0 at the crown base and 1 at the apex
   *   z  angle around the axis, 0..1
   *   w  how much of the shader's per-instance lobe this level may carry
   */
  aTree: Float32Array;
  index: Uint16Array;
  triangles: number;
  /** Where the crown's triangles start in `index`; everything before is trunk. */
  crownIndexStart: number;
}

/** Table lookup with smoothstep interpolation between entries. */
function sampleProfile(table: readonly number[], t: number): number {
  const n = table.length;
  const f = Math.min(Math.max(t, 0), 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const u = f - i;
  const s = u * u * (3 - 2 * u);
  return table[i] * (1 - s) + table[i + 1] * s;
}

/** The shape function itself: crown radius at an angle and a height. */
function rawRadius(form: TreeFormDef, theta: number, t: number): number {
  let l = 0;
  for (const lb of form.lobes) l += lb.amp * Math.sin(lb.n * theta + lb.phase + lb.twist * t);
  return sampleProfile(form.profile, t) * (1 + l);
}

/** Samples per axis in the prefilter. Odd, so the cell centre is sampled. */
const FILTER_TAPS = 5;

/**
 * The shape function averaged over one mesh cell.
 *
 * This is the whole of the level-of-detail scheme. A coarse ring stands for a
 * wedge of the crown, so its radius has to be that wedge's MEAN radius; point
 * sampling instead is what makes a coarse mesh a different shape rather than a
 * cheaper one, and it is also what aliases -- a seven-sided ring point-sampling
 * a seven-fold lobe reads it as a constant offset and the tree gets fatter or
 * thinner depending on nothing but the lobe's phase.
 */
function filteredRadius(
  form: TreeFormDef,
  theta: number,
  t: number,
  dTheta: number,
  dT: number,
): number {
  let sum = 0;
  for (let a = 0; a < FILTER_TAPS; a++) {
    const th = theta + ((a + 0.5) / FILTER_TAPS - 0.5) * dTheta;
    for (let b = 0; b < FILTER_TAPS; b++) {
      const tt = t + ((b + 0.5) / FILTER_TAPS - 0.5) * dT;
      sum += rawRadius(form, th, Math.min(1, Math.max(0, tt)));
    }
  }
  return sum / (FILTER_TAPS * FILTER_TAPS);
}

/** Signed volume of a closed indexed triangle mesh, by the divergence theorem. */
function meshVolume(pos: Float32Array, index: ArrayLike<number>, from: number, to: number): number {
  let v = 0;
  for (let i = from; i < to; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const bx = pos[b], by = pos[b + 1], bz = pos[b + 2];
    const cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Reference resolution for the volume the coarse levels are matched to. */
const REF_SIDES = 96;
const REF_RINGS = 48;

const refVolumes = new Map<string, number>();

/**
 * Crown volume of the shape function itself, evaluated far finer than any
 * shipped level. Cached: it is the same number for every level of a form.
 */
function referenceCrownVolume(form: TreeFormDef): number {
  const cached = refVolumes.get(form.name);
  if (cached !== undefined) return cached;
  const mesh = buildCrownOnly(form, REF_SIDES, REF_RINGS, 1);
  const v = meshVolume(mesh.pos, mesh.idx, 0, mesh.idx.length);
  refVolumes.set(form.name, v);
  return v;
}

/** The crown alone, as raw arrays, so the volume normalisation can iterate. */
function buildCrownOnly(
  form: TreeFormDef,
  sides: number,
  rings: number,
  radiusScale: number,
): { pos: Float32Array; idx: number[] } {
  const dTheta = TAU / sides;
  const dT = 1 / rings;
  const span = 1 - form.crownBase;
  const pos = new Float32Array((sides * rings + 2) * 3);
  // Vertex 0 is the skirt centre, then the rings, then the apex.
  pos[0] = 0; pos[1] = form.crownBase; pos[2] = 0;
  for (let k = 0; k < rings; k++) {
    const t = (k + 0.5) / rings;
    for (let j = 0; j < sides; j++) {
      const th = j * dTheta;
      const r = filteredRadius(form, th, t, dTheta, dT) * radiusScale;
      const v = (1 + k * sides + j) * 3;
      pos[v] = Math.cos(th) * r;
      pos[v + 1] = form.crownBase + span * t;
      pos[v + 2] = Math.sin(th) * r;
    }
  }
  const apex = sides * rings + 1;
  pos[apex * 3] = 0; pos[apex * 3 + 1] = 1; pos[apex * 3 + 2] = 0;

  const idx: number[] = [];
  // The underside: a fan facing DOWN, so its winding is the reverse of a band's.
  for (let j = 0; j < sides; j++) {
    idx.push(0, 1 + j, 1 + ((j + 1) % sides));
  }
  // Winding: for a ring pair (A below, B above) walked with the angle
  // increasing, (A_j, B_j, B_j+1) and (A_j, B_j+1, A_j+1) both come out
  // counter-clockwise seen from OUTSIDE, which is what FrontSide wants.
  for (let k = 0; k + 1 < rings; k++) {
    const a0 = 1 + k * sides, b0 = 1 + (k + 1) * sides;
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      idx.push(a0 + j, b0 + j, b0 + j2, a0 + j, b0 + j2, a0 + j2);
    }
  }
  const top = 1 + (rings - 1) * sides;
  for (let j = 0; j < sides; j++) {
    idx.push(top + j, apex, top + ((j + 1) % sides));
  }
  return { pos, idx };
}

/**
 * How much of the shader's per-instance lobe a level may carry.
 *
 * The shader adds a second, per-tree layer of lobes so that a stand is not one
 * ragged outline repeated at different yaws. Those lobes are point-sampled by
 * whatever ring the level has, so they need the same prefilter the baked ones
 * get; this is the analytic version of it, the sinc attenuation of the highest
 * shader harmonic at this level's angular pitch.
 */
function lobeGain(sides: number, highestHarmonic: number): number {
  const x = (highestHarmonic * Math.PI) / sides;
  return x === 0 ? 1 : Math.max(0, Math.sin(x) / x);
}

/** Highest harmonic in crownLobe() below. Kept beside it deliberately. */
const SHADER_LOBE_HARMONIC = 3;

/**
 * One unit tree: 1 m tall, nominal crown radius 1 m, standing on y = 0.
 *
 * Shared by the beauty pass and the depth pass, so a tree cannot cast a shadow
 * it does not have.
 */
export function buildTreeMesh(formIndex: number, lodIndex: number): TreeMesh {
  const form = TREE_FORMS[formIndex];
  const lod = TREE_LODS[lodIndex];
  const { sides, rings, trunkSides } = lod;

  // Scale the crown so this level holds the same volume as the shape function
  // it stands for. An inscribed polygon is smaller than what it approximates by
  // an amount that grows fast as the side count falls, and a far tree that is a
  // tenth thinner than the near one is a visible pop at the switch.
  const unit = buildCrownOnly(form, sides, rings, 1);
  const v = meshVolume(unit.pos, unit.idx, 0, unit.idx.length);
  const radiusScale = v > 0 ? Math.sqrt(referenceCrownVolume(form) / v) : 1;

  const pos: number[] = [];
  const attr: number[] = [];
  const idx: number[] = [];
  const gain = lobeGain(sides, SHADER_LOBE_HARMONIC);

  const push = (x: number, y: number, z: number, crown: number, depth: number, ang: number): number => {
    pos.push(x, y, z);
    attr.push(crown, depth, ang, crown > 0.5 ? gain : 0);
    return pos.length / 3 - 1;
  };

  const trunkRing = (yF: number, rF: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < trunkSides; j++) {
      const a = j / trunkSides;
      const th = a * TAU;
      out.push(push(Math.cos(th) * rF, yF, Math.sin(th) * rF, 0, 0, a));
    }
    return out;
  };

  const band = (a: number[], b: number[]): void => {
    for (let j = 0; j < a.length; j++) {
      const j2 = (j + 1) % a.length;
      idx.push(a[j], b[j], b[j2], a[j], b[j2], a[j2]);
    }
  };

  band(trunkRing(0, form.trunkR0), trunkRing(form.trunkTop, form.trunkR1));
  const crownIndexStart = idx.length;

  const dTheta = TAU / sides;
  const dT = 1 / rings;
  const span = 1 - form.crownBase;
  const skirt = push(0, form.crownBase, 0, 1, 0, 0);
  const ringIds: number[][] = [];
  for (let k = 0; k < rings; k++) {
    const t = (k + 0.5) / rings;
    const row: number[] = [];
    for (let j = 0; j < sides; j++) {
      const a = j / sides;
      const th = a * TAU;
      const r = filteredRadius(form, th, t, dTheta, dT) * radiusScale;
      row.push(push(Math.cos(th) * r, form.crownBase + span * t, Math.sin(th) * r, 1, t, a));
    }
    ringIds.push(row);
  }
  const apex = push(0, 1, 0, 1, 1, 0);

  for (let j = 0; j < sides; j++) idx.push(skirt, ringIds[0][j], ringIds[0][(j + 1) % sides]);
  for (let k = 0; k + 1 < rings; k++) band(ringIds[k], ringIds[k + 1]);
  const top = ringIds[rings - 1];
  for (let j = 0; j < sides; j++) idx.push(top[j], apex, top[(j + 1) % sides]);

  const position = new Float32Array(pos);
  const index = new Uint16Array(idx);

  // Smooth normals accumulated from the faces, not derived analytically. With
  // lobes baked into the surface there is no closed form for the normal any
  // more, and the faces are the definition of the surface anyway.
  //
  // The shader then moves these vertices -- a per-instance lobe, a lean, wind --
  // without moving the normals with them. That is deliberate: the error is a
  // few degrees on a surface whose shading normal the fragment shader is about
  // to perturb by a great deal more than that on purpose, and the alternative
  // is a per-vertex Jacobian for foliage.
  const normal = new Float32Array(position.length);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ux = position[b] - position[a], uy = position[b + 1] - position[a + 1], uz = position[b + 2] - position[a + 2];
    const vx = position[c] - position[a], vy = position[c + 1] - position[a + 1], vz = position[c + 2] - position[a + 2];
    // Not normalised: the cross product's length is twice the triangle area, so
    // accumulating it area-weights the average for free.
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) {
      normal[o] += nx; normal[o + 1] += ny; normal[o + 2] += nz;
    }
  }
  for (let i = 0; i < normal.length; i += 3) {
    const l = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;
    normal[i] /= l; normal[i + 1] /= l; normal[i + 2] /= l;
  }

  return {
    position,
    normal,
    aTree: new Float32Array(attr),
    index,
    triangles: index.length / 3,
    crownIndexStart,
  };
}

/**
 * Wind strength, 0 to 1, from the observed speed at 10 m in metres per second.
 *
 * Pure and exported because it is one half of the vertex displacement bound: a
 * vertex moves WIND_MAX_LOCAL crown radii times the sway times this, and the
 * check can only assert that bound if both factors are provably at most one.
 *
 * The floor is not dead calm on purpose. A canopy that is perfectly still reads
 * as a photograph of trees rather than as trees, and 12 m/s is about where a
 * crown is moving as much as three sines can honestly show.
 */
export function windStrength(speedMs: number): number {
  // A NaN speed fails both comparisons and would reach the shader as a NaN
  // vertex position, which is a hole in the canopy rather than a still tree.
  return Math.min(1, Math.max(0.08, speedMs / 12)) || 0.08;
}

/**
 * The shader half of the shape: what varies per TREE rather than per species.
 *
 * Kept in this file, and kept SCALAR, so test/trees.check.ts can transliterate
 * it to JavaScript and run the shipped source rather than a copy of it. Every
 * function here takes and returns floats only; the vector work that applies
 * them lives in src/render/trees.ts.
 */
export const TREE_SHAPE_GLSL = /* glsl */ `
// Per-instance crown lobes. The baked outline is one shape rotated by the
// instance yaw, which is enough variety in a hedgerow and not enough in a
// stand seen from above; this rotates and reshapes it per tree.
const float LOBE_A2 = 0.11;
const float LOBE_A3 = 0.08;

float crownLobe(float ang, float t, float seed) {
  return LOBE_A2 * sin(2.0 * ang + seed * 6.2831853 + t * 1.7)
       + LOBE_A3 * sin(3.0 * ang + seed * 15.7079633 - t * 2.3);
}

// Wind.
//
// A static forest is the loudest artificial signal in the frame after the
// silhouette, and this is the cheapest thing on the whole list: three sines in
// the vertex shader, no new pass, no new buffer.
//
// The two weight pairs each sum to one and the height weight is at most one, so
// |windSway| <= 1 BY CONSTRUCTION rather than by measurement, and the caller
// multiplies by WIND_MAX_LOCAL crown radii. That is what makes "no vertex
// travels more than a fixed fraction of the crown radius" an assertion about
// the code instead of a hope about the numbers.
const float WIND_W_A = 0.68;
const float WIND_W_B = 0.32;
const float WIND_FREQ_A = 1.15;
const float WIND_FREQ_B = 2.70;
const float WIND_GUST_BASE = 0.72;
const float WIND_GUST_AMP = 0.28;
const float WIND_FREQ_GUST = 0.23;

/** Sway at the crown top, as a fraction of the instance's crown radius. */
const float WIND_MAX_LOCAL = 0.14;

/**
 * Sway of a vertex, -1 to 1, for a unit tree.
 *
 * The parameter y is the vertex height, 0 at the foot of the trunk and 1 at
 * the apex; the square is what keeps the trunk planted while the crown moves,
 * and it makes the sway exactly zero at the base rather than nearly zero.
 */
float windSway(float y, float seed, float t, float gustPhase) {
  float w = clamp(y, 0.0, 1.0);
  w = w * w;
  float a = t * WIND_FREQ_A + seed * 6.2831853;
  float b = t * WIND_FREQ_B + seed * 15.7079633;
  float s = WIND_W_A * sin(a) + WIND_W_B * sin(b);
  // The gust is a WAVE crossing the wood rather than per-tree jitter: its phase
  // runs along the wind direction (the caller supplies it from the instance's
  // own position), so a stand ripples from one side to the other instead of
  // every tree breathing on its own.
  float gust = WIND_GUST_BASE + WIND_GUST_AMP * sin(t * WIND_FREQ_GUST - gustPhase);
  return w * s * gust;
}
`;
