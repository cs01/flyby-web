// Carriageway centreline -> raised pavement with a kerb, as triangle strips.
//
// WHY THIS EXISTS. From an aeroplane the strip between the kerb and the wall is
// four pixels of satellite drape and nobody looks at it. From a car at an eye
// height of 1.5 m it is a third of the frame, it is magnified to about half a
// metre per pixel, and it carries the photographed shadows and parked cars of
// whatever afternoon the satellite flew, which contradict the scene's own sun.
// A road ribbon fixed the carriageway the same way; this fixes what is beside
// it.
//
// THE STEP IS THE POINT. A pavement is 100-150 mm above the channel, and that
// step, catching light on its top and shading its face, is most of what makes a
// street read as a street from eye level. A flat differently-coloured band is
// most of the cost and almost none of the effect.
//
// Deliberately PURE: no THREE, no DOM, no height field, no spatial index. The
// three things it needs to know about the world (how high the carriageway is,
// whether a point is on some OTHER carriageway, and how far it is to the
// building line) arrive as callbacks, which is what lets test/pavement.check.ts
// drive the real builder with synthetic ones and assert on the actual numbers
// instead of on a copy of them.

import { RoadClass, roadWidthM, type Road, ROAD_BRIDGE, ROAD_TUNNEL } from "./roadpack";

/**
 * Height of the pavement surface above the channel it borders, in metres.
 *
 * British kerbs are laid to 125 mm upstand and American ones to about six
 * inches; 135 mm sits between them. The number matters more than it looks: at
 * 50 mm the step is invisible from a car and at 300 mm it reads as a wall.
 */
export const KERB_HEIGHT_M = 0.135;

/**
 * Crossfall of the pavement top, as a fall per metre away from the kerb.
 *
 * Real pavements are laid to about 1:40 so rain runs to the gutter. It is only
 * a few centimetres across a footway, and it exists here because a dead-flat
 * band picks up exactly one shade of the sky and reads as a painted stripe.
 */
export const PAVEMENT_CROSSFALL = 0.025;

/**
 * Pavement width by road class, metres. Zero means this class gets none.
 *
 * A motorway has no pavement, a footway IS one and is already drawn as its own
 * ribbon, and an alley usually has nothing more than a kerb. These are the
 * widths used where no building line is found to follow; see `clearanceM`.
 */
export const PAVEMENT_WIDTH_M: number[] = [
  0,   // motorway
  0,   // trunk
  4.4, // primary        an urban arterial: Van Ness, Michigan Avenue
  3.8, // secondary
  3.2, // tertiary
  3.0, // residential
  2.8, // unclassified
  1.5, // service        alleys and parking aisles
  2.2, // living_street
  3.0, // busway
  0,   // pedestrian     the whole surface is already the footway
  0,   // footway
  0,   // cycleway
  0,   // track
];

/**
 * How far from the city centre each class keeps its pavement, in metres,
 * before the budget solver scales it down.
 *
 * Far tighter than the road ranges in render/roads.ts, and deliberately so: a
 * kerb is 135 mm and is under a pixel past about 350 m, which is where the
 * fragment fade throws the whole thing away anyway. The range exists to bound
 * the GEOMETRY, and its only real job is to cover as much ground as a car can
 * drive across before the detail drape restitches under it.
 */
export const PAVEMENT_RANGE_M: number[] = [
  0,    // motorway
  0,    // trunk
  2400, // primary
  2400, // secondary
  2200, // tertiary
  2000, // residential
  2000, // unclassified
  900,  // service
  2000, // living_street
  2000, // busway
  0,    // pedestrian
  0,    // footway
  0,    // cycleway
  0,    // track
];

/** Never narrower than this, whatever the building line says. */
export const PAVEMENT_MIN_WIDTH_M = 1.2;
/**
 * Never wider than this, however far away the nearest building is.
 *
 * Without a cap, a road across a park or a car park grows a twelve-metre
 * concrete apron on each side, which is a worse lie than the drape it replaced.
 */
export const PAVEMENT_MAX_WIDTH_M = 8.0;

/** Spacing of the cross-sections the strip is built from, in metres. */
export const PAVEMENT_STATION_M = 5;

/**
 * Tile edge, in metres. A way belongs to the tile its centroid falls in, so a
 * long way reaches a little past its own tile; ways are a few tens of metres
 * long, so that overhang is small and costs nothing but a slightly generous
 * bounding sphere.
 */
export const PAVEMENT_TILE_M = 400;

/**
 * How far from the camera tiles are kept, in metres.
 *
 * Comfortably past the 330 m at which the shader throws every fragment away,
 * with room for the tile-centroid overhang and for the camera to move between
 * tile crossings without a hole opening ahead of it.
 */
export const PAVEMENT_RING_M = 850;

/**
 * Longest mitre allowed at a bend, as a multiple of the half width. Same
 * reasoning and same number as MITRE_LIMIT in ribbon.ts: an unclamped mitre on
 * a hairpin runs the offset out to infinity.
 */
export const PAVEMENT_MITRE_LIMIT = 2.0;

/** Two centreline points closer than this are the same point; see ribbon.ts. */
const DUP_EPS_M = 1e-4;

/**
 * Steepest drop from the pavement's back edge down to the terrain, in metres.
 *
 * The back edge chases the ground so the pavement blends into whatever the
 * drape shows rather than ending in a cliff. Unclamped, one bad DEM sample on a
 * San Francisco hillside tears a several-metre skirt out of the strip.
 */
export const VERGE_MAX_FALL_M = 0.9;

/** Face kinds, written into the `info` attribute and read by the shader. */
export const FACE_KERB = 0;
/** Pavement top that runs up to a building line: concrete all the way out. */
export const FACE_PAVEMENT = 1;
/** Pavement top with nothing to run up to: the back edge turns into verge. */
export const FACE_PAVEMENT_OPEN = 2;

/**
 * Added to the face kind for the second of the two sides.
 *
 * The shader wants to know which pavement of the pair it is drawing so its
 * street lamps can alternate in step with the ones render/roads.ts paints on
 * the carriageway. It cannot be recovered from the outward normal, and it
 * cannot be recovered by splitting what one road appended down the middle
 * either: the two sides suppress different stations at a junction and so emit
 * different numbers of vertices. So it is encoded here, at the one place that
 * knows.
 */
export const PAVEMENT_SIDE_STRIDE = 4;

/** True if this way is the kind of thing that has a pavement beside it. */
/**
 * Classes that block a pavement where they cross it, and that a lamp column or
 * a parked car must not be planted in the middle of.
 *
 * Everything a vehicle drives on, including the motorways and trunk roads that
 * get no pavement of their own: a footway laid across a freeway is the single
 * worst artefact this file could ship.
 *
 * Here rather than in render/pavement.ts because it is now three callers -- the
 * pavement, the street lamps and the parked cars -- and all three have to agree
 * on what tarmac is.
 */
export function isCarriageway(r: Road): boolean {
  return r.cls <= RoadClass.Busway && (r.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) === 0;
}

export function hasPavement(r: Road): boolean {
  if ((r.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) !== 0) return false;
  return (PAVEMENT_WIDTH_M[r.cls] ?? 0) > 0;
}

/** Default pavement width for a class, metres; 0 where the class gets none. */
export function pavementWidthM(cls: RoadClass): number {
  return PAVEMENT_WIDTH_M[cls] ?? 0;
}

export interface PavementScratch {
  /** x, y, z per vertex, local ENU metres. */
  pos: number[];
  /** u = metres along the centreline, t = metres out from the kerb line. */
  uv: number[];
  /** faceKind, outward direction x, outward direction z, pavement width. */
  info: number[];
  idx: number[];
}

export function emptyPavement(): PavementScratch {
  return { pos: [], uv: [], info: [], idx: [] };
}

export interface PavementWorld {
  /** Height of the CARRIAGEWAY SURFACE at (x, z): ground plus the road lift. */
  roadSurfaceY(x: number, z: number): number;
  /** Bare ground height at (x, z), for the verge to chase. */
  groundY(x: number, z: number): number;
  /**
   * True if (x, z) lies on some carriageway.
   *
   * This is what opens the pavement at every junction. Without it the strip
   * generated along one road runs straight across the one it crosses, and every
   * crossroads in the city grows a 135 mm concrete slab laid across it.
   */
  onCarriageway(x: number, z: number): boolean;
  /**
   * Metres from (x, z) to the building line along the unit direction (dx, dz),
   * or `maxM` if nothing was hit. This is what makes the pavement run up to the
   * wall on a dense street and stay a sensible width on an open one.
   */
  clearanceM(x: number, z: number, dx: number, dz: number, maxM: number): number;
}

/**
 * Triangles one way's pavement costs, for the budget solver. Exact, and it
 * needs no callbacks, which is the point: the solver runs over the whole pack
 * before any of the expensive per-station queries happen.
 */
export function pavementTriangleCost(r: Road, stationM = PAVEMENT_STATION_M): number {
  let stations = 0;
  for (let i = 2; i < r.pts.length; i += 2) {
    const len = Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]);
    stations += Math.max(1, Math.round(len / stationM));
  }
  // Two sides, and each interval is a kerb face quad plus a pavement top quad.
  return stations * 2 * 4;
}

/** One cross-section of the strip, in the order the builder computes them. */
interface Station {
  /** Kerb line, at the carriageway edge. */
  kx: number;
  kz: number;
  /** Outward unit normal, away from the carriageway. */
  nx: number;
  nz: number;
  /** Metres along the centreline. */
  u: number;
  /** Channel level and pavement level at the kerb. */
  gutterY: number;
  topY: number;
  /** Pavement width and the height of its back edge. */
  w: number;
  backY: number;
  /** True where a crossing carriageway takes the pavement out. */
  suppressed: boolean;
  /** True where no building line was found within the cap. */
  open: boolean;
}

/**
 * Resample a centreline at roughly `stationM`, keeping every original vertex.
 *
 * Keeping the vertices matters: they are where the road bends, and a bend
 * rounded off by resampling puts the kerb through the corner of the block.
 * Returns x, z, and the per-point mitre normal and scale.
 */
function stations(px: number[], pz: number[], stationM: number): {
  x: number[]; z: number[]; nx: number[]; nz: number[]; scale: number[]; u: number[];
} {
  const n = px.length;
  const segCount = n - 1;
  const dirX = new Float64Array(segCount);
  const dirZ = new Float64Array(segCount);
  const arc = new Float64Array(n);
  for (let i = 0; i < segCount; i++) {
    const dx = px[i + 1] - px[i];
    const dz = pz[i + 1] - pz[i];
    const len = Math.hypot(dx, dz);
    dirX[i] = dx / len;
    dirZ[i] = dz / len;
    arc[i + 1] = arc[i] + len;
  }

  const ox: number[] = [];
  const oz: number[] = [];
  const onx: number[] = [];
  const onz: number[] = [];
  const oscale: number[] = [];
  const ou: number[] = [];

  const emit = (x: number, z: number, u: number, nx: number, nz: number, scale: number): void => {
    ox.push(x); oz.push(z); onx.push(nx); onz.push(nz); oscale.push(scale); ou.push(u);
  };

  const push = (x: number, z: number, u: number, a: number, b: number): void => {
    // At a shared vertex the normal is the bisector of the two segments and the
    // offset runs out by 1/cos(phi/2); inside a segment a and b are the same
    // segment and this degenerates to that segment's own normal at scale 1.
    let mx = dirZ[a] + dirZ[b];
    let mz = -dirX[a] - dirX[b];
    const ml = Math.hypot(mx, mz);
    // ml is 2 cos(phi/2), so it collapses to zero exactly when the way doubles
    // back and there is no bisector to mitre along.
    const scale = ml > 1e-9 ? 2 / ml : Infinity;
    if (scale <= PAVEMENT_MITRE_LIMIT) {
      emit(x, z, u, mx / ml, mz / ml, scale);
      return;
    }
    // BEVEL, not a clamped mitre. Clamping the scale looks like the obvious
    // answer and it is wrong in the one way that matters here: it pulls the
    // offset point back ALONG the bisector, so at a hairpin the kerb ends up
    // less than a half width from the carriageway and the pavement is laid on
    // the nearside lane. Measured on sf.roads, a clamped mitre put the kerb
    // 496 mm inside the carriageway. Emitting one cross-section per segment
    // normal instead cuts the corner square and every vertex stays exactly one
    // half width off its own segment. Both sections carry the same u, so the
    // quad between them has no length along the road: it is the wedge that
    // fills the outer corner, and it stretches no slab. Same fix, same reason,
    // as the bevel in data/ribbon.ts.
    emit(x, z, u, dirZ[a], -dirX[a], 1);
    emit(x, z, u, dirZ[b], -dirX[b], 1);
  };

  push(px[0], pz[0], arc[0], 0, 0);
  for (let i = 0; i < segCount; i++) {
    const len = arc[i + 1] - arc[i];
    const steps = Math.max(1, Math.round(len / stationM));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      push(px[i] + (px[i + 1] - px[i]) * t, pz[i] + (pz[i + 1] - pz[i]) * t,
           arc[i] + len * t, i, i);
    }
    // The segment end: a bisector at an interior vertex, this segment's own
    // normal at the last one.
    push(px[i + 1], pz[i + 1], arc[i + 1], i, Math.min(i + 1, segCount - 1));
  }
  return { x: ox, z: oz, nx: onx, nz: onz, scale: oscale, u: ou };
}

/**
 * Append one carriageway's two pavements to `s`. Returns triangles added.
 *
 * INVARIANTS the gate asserts, all of them by construction here:
 *   * no vertex is closer to the centreline than the carriageway half width,
 *     so the pavement can never overlap the road it borders;
 *   * the pavement top is exactly KERB_HEIGHT_M above the CARRIAGEWAY surface
 *     sampled at the same kerb point, so it can never sit below the road;
 *   * no quad survives whose middle lies on another carriageway.
 */
export function addPavement(
  s: PavementScratch,
  r: Road,
  world: PavementWorld,
  stationM = PAVEMENT_STATION_M,
): number {
  const width = roadWidthM(r.cls, r.lanes, r.flags);
  const defaultW = pavementWidthM(r.cls);
  if (!(width > 0) || !(defaultW > 0)) return 0;
  const hw = width * 0.5;

  const px: number[] = [];
  const pz: number[] = [];
  for (let i = 0; i + 1 < r.pts.length; i += 2) {
    const x = r.pts[i];
    const z = r.pts[i + 1];
    const last = px.length - 1;
    if (last >= 0 && Math.abs(x - px[last]) < DUP_EPS_M && Math.abs(z - pz[last]) < DUP_EPS_M) continue;
    px.push(x);
    pz.push(z);
  }
  if (px.length < 2) return 0;

  const st = stations(px, pz, stationM);
  let tris = 0;
  for (const side of [1, -1]) {
    const row: Station[] = [];
    for (let i = 0; i < st.x.length; i++) {
      const nx = st.nx[i] * side;
      const nz = st.nz[i] * side;
      // The kerb sits on the carriageway edge, mitred exactly as the road
      // ribbon's own edge vertex is, so the two meet with no gap and no lap.
      const kx = st.x[i] + nx * hw * st.scale[i];
      const kz = st.z[i] + nz * hw * st.scale[i];
      const gutterY = world.roadSurfaceY(kx, kz);
      const topY = gutterY + KERB_HEIGHT_M;

      // How far to the building line, from the kerb, straight out. Where a wall
      // is found the pavement runs to it and the drape between kerb and
      // building disappears entirely; where none is, the class width stands.
      const clr = world.clearanceM(kx, kz, nx, nz, PAVEMENT_MAX_WIDTH_M);
      const open = clr >= PAVEMENT_MAX_WIDTH_M;
      const w = open
        ? defaultW
        : Math.max(PAVEMENT_MIN_WIDTH_M, Math.min(clr, PAVEMENT_MAX_WIDTH_M));

      const bx = kx + nx * w;
      const bz = kz + nz * w;
      const flatY = topY - PAVEMENT_CROSSFALL * w;
      // An open back edge chases the ground so the strip melts into the drape
      // instead of ending in a step; a closed one stays flat up to the wall.
      const backY = open
        ? Math.max(flatY - VERGE_MAX_FALL_M, Math.min(flatY, world.groundY(bx, bz)))
        : flatY;

      // Junction test at the MIDDLE of the strip, not at the kerb: the kerb of
      // this road lies exactly on its own carriageway boundary, and testing
      // there would have every road delete its own pavement.
      const suppressed = world.onCarriageway(kx + nx * w * 0.5, kz + nz * w * 0.5);

      row.push({ kx, kz, nx, nz, u: st.u[i], gutterY, topY, w, backY, suppressed, open });
    }

    // Emit in RUNS of consecutive surviving stations, so a junction opens a gap
    // rather than splicing two distant cross-sections into one long quad.
    let i = 0;
    while (i < row.length) {
      if (row[i].suppressed) { i++; continue; }
      let j = i;
      while (j + 1 < row.length && !row[j + 1].suppressed) j++;
      if (j > i) tris += emitRun(s, row, i, j, side > 0 ? 0 : 1);
      i = j + 1;
    }
  }
  return tris;
}

/** One unbroken run of stations, as a kerb-face strip and a pavement strip. */
function emitRun(
  s: PavementScratch,
  row: Station[],
  i0: number,
  i1: number,
  side01: number,
): number {
  const count = i1 - i0 + 1;
  const base = s.pos.length / 3;

  for (let i = i0; i <= i1; i++) {
    const a = row[i];
    const bump = side01 * PAVEMENT_SIDE_STRIDE;
    const kerb = FACE_KERB + bump;
    const kind = (a.open ? FACE_PAVEMENT_OPEN : FACE_PAVEMENT) + bump;
    // Kerb face: bottom then top, both on the kerb line.
    s.pos.push(a.kx, a.gutterY, a.kz);
    s.uv.push(a.u, -KERB_HEIGHT_M);
    s.info.push(kerb, a.nx, a.nz, a.w);
    s.pos.push(a.kx, a.topY, a.kz);
    s.uv.push(a.u, 0);
    s.info.push(kerb, a.nx, a.nz, a.w);
    // Pavement top: front then back. The front vertex is coincident with the
    // kerb face's top one but carries an upward normal, so the arris between
    // them stays a hard edge instead of being smoothed into a roll.
    s.pos.push(a.kx, a.topY, a.kz);
    s.uv.push(a.u, 0);
    s.info.push(kind, a.nx, a.nz, a.w);
    s.pos.push(a.kx + a.nx * a.w, a.backY, a.kz + a.nz * a.w);
    s.uv.push(a.u, a.w);
    s.info.push(kind, a.nx, a.nz, a.w);
  }

  // Both strips are drawn double-sided (see render/pavement.ts), so the winding
  // decides nothing and one order serves the vertical face and the horizontal
  // one alike.
  let tris = 0;
  for (let k = 0; k + 1 < count; k++) {
    const p = base + k * 4;
    const q = p + 4;
    s.idx.push(p, q, p + 1, p + 1, q, q + 1);
    s.idx.push(p + 2, q + 2, p + 3, p + 3, q + 2, q + 3);
    tris += 4;
  }
  return tris;
}
