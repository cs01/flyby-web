// Low-poly car archetypes, built from boxes at load time.
//
// NO ASSETS, AND THAT IS NOT A COMPROMISE HERE. This repo has no asset
// pipeline and docs/roadmap.md says why it is not getting one. For cars the
// argument is stronger than for anything else in the scene: every real make and
// model is a registered design, correctly licensed models of them do not exist
// at a price a browser toy can pay, and the rips that circulate are exactly the
// thing not to ship. What a car has to do here is read as a car at two pixels
// from an aircraft and as a plausible object at two metres from the pavement,
// and eighty triangles of box does both.
//
// FOUR ARCHETYPES, NOT ONE. A street of identical saloons is the same failure a
// stand of identical trees is, and it is cheaper to fix: the silhouette above
// the waistline is most of what tells a van from a hatchback at any distance,
// so the four shapes differ in cabin length, cabin height and overall height
// rather than in detail nobody can resolve.
//
// The parts carry an id rather than a material, so one draw call paints body,
// glass, wheels and lamps: `aPart` is read by the fragment shader in
// render/traffic.ts, which is also where the per-instance colour arrives.
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

export interface CarArchetype {
  name: string;
  lengthM: number;
  widthM: number;
  /** Height of the waistline: the top of the lower body. */
  waistM: number;
  /** Height of the roof. */
  roofM: number;
  /** Where the cabin starts and ends, as a fraction of the length measured
   *  from the TAIL. A van is nearly 0..1; a pickup's cabin is forward of
   *  centre and everything behind it is open bed. */
  cabin0: number;
  cabin1: number;
  /** True for a body with an open load bed behind the cabin. */
  bed: boolean;
  /** Radius of a wheel, and how far the axles sit from the ends. */
  wheelR: number;
  overhang: number;
  /** How far the roof is pulled back from the bottom of the windscreen and of
   *  the backlight, as a fraction of the cabin's own length. A box with
   *  vertical glass at both ends is the single loudest tell that a car is four
   *  cuboids; the rake is what makes the silhouette read as a car at the two
   *  metres `sf-van-ness-kerb` is taken from. A van is nearly upright and a
   *  hatchback is not, and that difference is most of what tells them apart. */
  rakeFront: number;
  rakeRear: number;
  /**
   * How much of the cabin, measured back from the windscreen, is GLAZED.
   *
   * The cabin is one box and the shader decides per fragment which of its faces
   * is glass, so an archetype whose cabin is nearly the whole vehicle -- a van
   * -- came out as a black glass brick five metres long. A van has a windscreen
   * and two front side windows and then a metre and a half of blank panel, and
   * this is the fraction that says where the glass stops. 1 for a car, whose
   * cabin IS its greenhouse.
   */
  glazeFrac: number;
}

/**
 * The set. Proportions are ordinary road-car figures in metres, which matters
 * more than it sounds: a car modelled 10% too big is the most reliable way to
 * make a correctly sized street look wrong.
 */
export const CAR_ARCHETYPES: readonly CarArchetype[] = [
  {
    name: "saloon",
    lengthM: 4.65, widthM: 1.82, waistM: 0.92, roofM: 1.45,
    cabin0: 0.24, cabin1: 0.74, wheelR: 0.33, overhang: 0.85, bed: false,
    rakeFront: 0.26, rakeRear: 0.20,
    glazeFrac: 1.0,
  },
  {
    name: "hatch",
    lengthM: 4.05, widthM: 1.76, waistM: 0.90, roofM: 1.50,
    cabin0: 0.08, cabin1: 0.66, wheelR: 0.31, overhang: 0.75, bed: false,
    rakeFront: 0.28, rakeRear: 0.11,
    glazeFrac: 1.0,
  },
  {
    name: "van",
    lengthM: 5.30, widthM: 1.96, waistM: 1.05, roofM: 2.35,
    cabin0: 0.03, cabin1: 0.92, wheelR: 0.35, overhang: 0.90, bed: false,
    rakeFront: 0.10, rakeRear: 0.04,
    glazeFrac: 0.40,
  },
  {
    name: "pickup",
    lengthM: 5.45, widthM: 1.95, waistM: 1.05, roofM: 1.82,
    cabin0: 0.40, cabin1: 0.78, wheelR: 0.38, overhang: 1.05, bed: true,
    rakeFront: 0.24, rakeRear: 0.07,
    glazeFrac: 1.0,
  },
];

export interface CarMesh {
  position: Float32Array;
  normal: Float32Array;
  /**
   * Where a fragment is ON ITS OWN PART, and what the part needs to know about
   * the car it belongs to. Four components:
   *
   *   x  part id, as PART_* above.
   *   y  0..1 along the part, tail to nose. For a body panel that is the whole
   *      car; for the cabin it is the cabin, so the shader can find the A and C
   *      posts without being told where the cabin starts.
   *   z  0..1 up the part, in units the shader can use without knowing the
   *      archetype: WHEEL DIAMETERS for a body panel, so the arch is always a
   *      circle of the same radius about 0.5 whatever the car; the glazing's
   *      own height for the cabin, so the rubber seal is always at 0.
   *   w  the axle inset as a fraction of the length. The axles are symmetric
   *      about the middle, so ONE number places both arches.
   *
   * All four are constant along an edge, so this is a linear interpolation and
   * nothing here needs a derivative.
   */
  aPart: Float32Array;
  index: Uint16Array;
  triangles: number;
}

interface Builder {
  pos: number[];
  nrm: number[];
  part: number[];
  idx: number[];
}

/** How a part maps a local position to the (u, v) the shader reads. */
interface Surface {
  u0: number;
  uSpan: number;
  v0: number;
  vSpan: number;
  /** Copied into aPart.w for every vertex of the car. */
  axle: number;
}

function push(b: Builder, x: number, y: number, z: number, n: number[], part: number, s: Surface): void {
  b.pos.push(x, y, z);
  b.nrm.push(n[0], n[1], n[2]);
  b.part.push(part, (x - s.u0) / s.uSpan, (y - s.v0) / s.vSpan, s.axle);
}

/** One quad, wound so the given normal points out of it. */
function quad(b: Builder, c: number[], n: number[], part: number, s: Surface): void {
  const base = b.pos.length / 3;
  for (let i = 0; i < 4; i++) push(b, c[i * 3], c[i * 3 + 1], c[i * 3 + 2], n, part, s);
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number[] {
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** A quad whose normal is computed from its own corners rather than given. */
function facet(b: Builder, c: number[], part: number, s: Surface): void {
  const n = cross(
    c[3] - c[0], c[4] - c[1], c[5] - c[2],
    c[6] - c[0], c[7] - c[1], c[8] - c[2],
  );
  quad(b, c, n, part, s);
}

/**
 * A box whose top face may be shorter and narrower than its bottom one.
 *
 * With the top equal to the bottom this is an ordinary axis-aligned box. With
 * it pulled in, the four sides slope, and that is the whole point: a cabin
 * needs a raked windscreen and a little tumblehome, and both fall out of one
 * pair of rectangles.
 */
function prism(
  b: Builder,
  bx0: number, bx1: number, bz: number,
  tx0: number, tx1: number, tz: number,
  y0: number, y1: number,
  part: number,
  s: Surface,
): void {
  // Bottom corners, then top, both counter-clockwise seen from above.
  const B = [[bx0, y0, -bz], [bx1, y0, -bz], [bx1, y0, bz], [bx0, y0, bz]];
  const T = [[tx0, y1, -tz], [tx1, y1, -tz], [tx1, y1, tz], [tx0, y1, tz]];
  const flat = (r: number[][]): number[] => r.flat();
  // Top and bottom.
  quad(b, flat([T[0], T[3], T[2], T[1]]), [0, 1, 0], part, s);
  quad(b, flat([B[0], B[1], B[2], B[3]]), [0, -1, 0], part, s);
  // The four sloping sides, each wound so its computed normal faces outward.
  facet(b, flat([B[1], T[1], T[2], B[2]]), part, s); // nose
  facet(b, flat([B[3], T[3], T[0], B[0]]), part, s); // tail
  facet(b, flat([B[2], T[2], T[3], B[3]]), part, s); // +z flank
  facet(b, flat([B[0], T[0], T[1], B[1]]), part, s); // -z flank
}

/**
 * Build one archetype.
 *
 * The lamp lenses stand 15 mm proud of the body face they sit on rather than
 * being coplanar with it. Coplanar would z-fight, and the alternative -- a
 * polygon offset -- is a per-material state this mesh should not need when
 * fifteen millimetres is a real dimension a real lamp lens has.
 *
 * There is no separate roof panel. The cabin's top face is body-coloured by
 * the fragment shader, which knows a roof by its normal, and twelve triangles
 * that exist only to be a different colour are twelve triangles on the mesh
 * with more instances in the frame than anything else.
 */
export function buildCarMesh(archetype: number): CarMesh {
  const a = CAR_ARCHETYPES[archetype];
  const b: Builder = { pos: [], nrm: [], part: [], idx: [] };
  const L = a.lengthM;
  const hw = a.widthM * 0.5;
  const nose = L * 0.5;
  const tail = -L * 0.5;
  // The sill sits above the ground, so the shadow under the car has a gap in it
  // the way a real one does.
  const sill = a.wheelR * 0.55;
  const axle = a.overhang / L;

  // Body panels are measured along the whole car and in wheel diameters up,
  // which is what makes one set of arch constants fit a hatchback and a van.
  const bodyS: Surface = { u0: tail, uSpan: L, v0: 0, vSpan: a.wheelR * 2, axle };
  const anyS: Surface = { u0: tail, uSpan: L, v0: 0, vSpan: Math.max(a.roofM, 1e-3), axle };

  // Lower body, tucked in a little at each end so the corners are not square,
  // and a touch narrower at the waist than at the sill.
  prism(b, tail + 0.12, nose - 0.12, hw, tail + 0.16, nose - 0.16, hw * 0.985,
    sill, a.waistM, PART_BODY, bodyS);
  // A dark sill band under the body: it hides the gap between the wheels and
  // reads as shadow from any angle.
  prism(b, tail + 0.30, nose - 0.30, hw * 0.94, tail + 0.30, nose - 0.30, hw * 0.94,
    sill * 0.35, sill + 0.02, PART_WHEEL, anyS);

  // Cabin. Narrower than the body, so there is a shoulder line to catch light,
  // and raked at both ends. Glass on every face; the shader paints the roof and
  // the posts back to body colour, which is cheaper than modelling them and
  // puts the posts where a fragment can see them rather than where a vertex is.
  const c0 = tail + L * a.cabin0;
  const c1 = tail + L * a.cabin1;
  const cl = c1 - c0;
  const cw = hw * 0.93;
  // Anchored at the WINDSCREEN, not at the back of the cabin: u = 1 is the top
  // of the windscreen on every archetype, u = 0 is where the glazing ends, and
  // anything aft of that comes out NEGATIVE, which is how the shader knows a
  // van's flank from a saloon's rear quarter light without being told which it
  // is holding.
  const glazedLen = Math.max(cl * a.glazeFrac, 1e-3);
  const cabinS: Surface = {
    u0: c1 - glazedLen, uSpan: glazedLen,
    v0: a.waistM - 0.02, vSpan: Math.max(a.roofM - a.waistM + 0.02, 1e-3),
    axle,
  };
  prism(b, c0, c1, cw, c0 + cl * a.rakeRear, c1 - cl * a.rakeFront, cw * 0.90,
    a.waistM - 0.02, a.roofM, PART_GLASS, cabinS);

  // The load bed: a shallow open box behind the cabin. It is what stops a
  // pickup reading as a hatchback with a long bonnet.
  if (a.bed) {
    prism(b, tail + 0.16, c0, hw * 0.97, tail + 0.16, c0, hw * 0.97,
      a.waistM - 0.02, a.waistM + 0.22, PART_BODY, bodyS);
  }

  // Wheels, as boxes. A cylinder would be sixteen more triangles for a shape
  // that is under two pixels wherever it is not partly hidden by its own arch.
  const axleF = nose - a.overhang;
  const axleR = tail + a.overhang;
  for (const ax of [axleF, axleR]) {
    for (const zs of [-1, 1]) {
      const zc = zs * (hw - 0.10);
      const b0 = zc - 0.11;
      const b1 = zc + 0.11;
      // A wheel is placed by its own box, so it gets the whole-car surface: no
      // shader term reads a wheel's uv.
      prism(b, ax - a.wheelR, ax + a.wheelR, (b1 - b0) * 0.5,
        ax - a.wheelR, ax + a.wheelR, (b1 - b0) * 0.5,
        0.0, a.wheelR * 2, PART_WHEEL, anyS);
      // prism is centred on z = 0, so shift the four-and-twenty vertices it
      // just pushed onto the axle. Cheaper than a second parameterisation.
      const n = 24 * 3;
      for (let i = b.pos.length - n + 2; i < b.pos.length; i += 3) b.pos[i] += zc;
    }
  }

  // Lamps. Two at each end, at the height a real lamp cluster sits.
  const lensX = nose - 0.12 + 0.015;
  const lensY0 = a.waistM * 0.52;
  const lensY1 = a.waistM * 0.52 + 0.20;
  for (const zs of [-1, 1]) {
    const z0 = zs > 0 ? hw * 0.42 : -hw * 0.92;
    const z1 = zs > 0 ? hw * 0.92 : -hw * 0.42;
    quad(b, [lensX, lensY0, z0, lensX, lensY1, z0, lensX, lensY1, z1, lensX, lensY0, z1],
      [1, 0, 0], PART_HEADLIGHT, anyS);
    const rx = tail + 0.12 - 0.015;
    quad(b, [rx, lensY0, z1, rx, lensY1, z1, rx, lensY1, z0, rx, lensY0, z0],
      [-1, 0, 0], PART_TAILLIGHT, anyS);
  }

  return {
    position: new Float32Array(b.pos),
    normal: new Float32Array(b.nrm),
    aPart: new Float32Array(b.part),
    index: new Uint16Array(b.idx),
    triangles: b.idx.length / 3,
  };
}

/** Triangles in each archetype, for the frame budget the harness reports. */
export const CAR_TRIANGLES: readonly number[] = CAR_ARCHETYPES.map(
  (_a, i) => buildCarMesh(i).triangles,
);
