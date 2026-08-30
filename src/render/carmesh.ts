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
  },
  {
    name: "hatch",
    lengthM: 4.05, widthM: 1.76, waistM: 0.90, roofM: 1.50,
    cabin0: 0.08, cabin1: 0.66, wheelR: 0.31, overhang: 0.75, bed: false,
  },
  {
    name: "van",
    lengthM: 5.30, widthM: 1.96, waistM: 1.05, roofM: 2.35,
    cabin0: 0.03, cabin1: 0.92, wheelR: 0.35, overhang: 0.90, bed: false,
  },
  {
    name: "pickup",
    lengthM: 5.45, widthM: 1.95, waistM: 1.05, roofM: 1.82,
    cabin0: 0.40, cabin1: 0.78, wheelR: 0.38, overhang: 1.05, bed: true,
  },
];

export interface CarMesh {
  position: Float32Array;
  normal: Float32Array;
  /** x: part id. y: 0 at the tail, 1 at the nose, for the paint gradient. */
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

/** One axis-aligned box, as six quads with outward normals. */
function box(
  b: Builder,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  part: number,
  lengthM: number,
): void {
  const faces: [number[], number[]][] = [
    [[x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1], [1, 0, 0]],
    [[x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0], [-1, 0, 0]],
    [[x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0], [0, 1, 0]],
    [[x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1], [0, -1, 0]],
    [[x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1], [0, 0, 1]],
    [[x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0], [0, 0, -1]],
  ];
  for (const [quad, n] of faces) {
    const base = b.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      const px = quad[i * 3];
      const py = quad[i * 3 + 1];
      const pz = quad[i * 3 + 2];
      b.pos.push(px, py, pz);
      b.nrm.push(n[0], n[1], n[2]);
      // The nose is at +x; the gradient runs 0 at the tail to 1 at the nose.
      b.part.push(part, lengthM > 0 ? px / lengthM + 0.5 : 0.5);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** One outward-facing quad, for a lamp lens laid on a body face. */
function quad(
  b: Builder,
  p: number[],
  n: number[],
  part: number,
  lengthM: number,
): void {
  const base = b.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    b.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    b.nrm.push(n[0], n[1], n[2]);
    b.part.push(part, lengthM > 0 ? p[i * 3] / lengthM + 0.5 : 0.5);
  }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Build one archetype.
 *
 * The lamp lenses stand 15 mm proud of the body face they sit on rather than
 * being coplanar with it. Coplanar would z-fight, and the alternative -- a
 * polygon offset -- is a per-material state this mesh should not need when
 * fifteen millimetres is a real dimension a real lamp lens has.
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

  // Lower body, tucked in a little at each end so the corners are not square.
  box(b, tail + 0.12, sill, -hw, nose - 0.12, a.waistM, hw, PART_BODY, L);
  // A dark sill band under the body: it hides the gap between the wheels and
  // reads as shadow from any angle, for twelve triangles.
  box(b, tail + 0.30, sill * 0.35, -hw * 0.94, nose - 0.30, sill + 0.02, hw * 0.94, PART_WHEEL, L);

  // Cabin. Narrower than the body, so there is a shoulder line to catch light.
  const c0 = tail + L * a.cabin0;
  const c1 = tail + L * a.cabin1;
  const cw = hw * 0.93;
  box(b, c0, a.waistM - 0.02, -cw, c1, a.roofM, cw, PART_GLASS, L);
  // The roof panel, painted body colour rather than glass.
  box(b, c0 + 0.12, a.roofM - 0.06, -cw * 0.98, c1 - 0.12, a.roofM, cw * 0.98, PART_BODY, L);

  // The load bed: a shallow open box behind the cabin, twelve triangles. It is
  // what stops a pickup reading as a hatchback with a long bonnet.
  if (a.bed) {
    box(b, tail + 0.16, a.waistM - 0.02, -hw * 0.97, c0, a.waistM + 0.22, hw * 0.97, PART_BODY, L);
  }

  // Wheels, as boxes. A cylinder would be sixteen more triangles for a shape
  // that is under two pixels wherever it is not partly hidden by its own arch.
  const axleF = nose - a.overhang;
  const axleR = tail + a.overhang;
  for (const ax of [axleF, axleR]) {
    for (const zs of [-1, 1]) {
      const zc = zs * (hw - 0.10);
      box(b, ax - a.wheelR, 0.0, zc - 0.11, ax + a.wheelR, a.wheelR * 2, zc + 0.11, PART_WHEEL, L);
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
      [1, 0, 0], PART_HEADLIGHT, L);
    const rx = tail + 0.12 - 0.015;
    quad(b, [rx, lensY0, z1, rx, lensY1, z1, rx, lensY1, z0, rx, lensY0, z0],
      [-1, 0, 0], PART_TAILLIGHT, L);
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
