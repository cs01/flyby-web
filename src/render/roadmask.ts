// Where the carriageways are, built from the baked road centrelines.
//
// The terrain shader paints ground grass from the ESA WorldCover herbaceous
// channel, and that channel is a 10 m posting: 1200x1200 over +/-6000 m, the
// figure `bun tools/verify-land.ts` prints for every pack. A suburban street
// plus its verges is about ONE texel wide at that scale, and WorldCover labels
// a texel by what dominates it, which in a leafy suburb is lawn. So the
// measurement says "grass" over the tarmac, and standing on a street in
// Emerald Hills the lawn runs up to the kerb and over it.
//
// This is the argument render/urbanmask.ts makes in its own header, applied to
// a second input. The road pack is not an inference either: it is the actual
// centrelines with widths, so a coverage grid over them says exactly where the
// tarmac is at a resolution the landcover raster cannot reach.
//
// It does NOT try to say where the verge is. Suppression is full only over the
// carriageway and a metre and a half of kerb, then it ramps off: the verge
// really is lawn, and the bug was that the lawn arrived with no transition,
// not that it existed.
//
// Pure data in, pure data out, for the reason data/landmask.ts is pure: the
// same maths the GPU samples has to be runnable under Bun or test/roadmask.
// check.ts would be a second opinion about the mask rather than an oracle on
// it. Only buildRoadMask below touches THREE.

import * as THREE from "three";
import {
  RoadClass, roadWidthM,
  type Road, type RoadPack,
} from "../data/roadpack";

/**
 * Metres per texel to aim for.
 *
 * Half a WorldCover texel. The mask exists precisely to disagree with the
 * landcover grid INSIDE one of its 10 m cells ("tarmac here, lawn there"), and
 * a grid that cannot resolve better than the thing it is correcting cannot say
 * that. urbanmask's ~85 m is right for "is this a city block" and useless here.
 */
const TARGET_CELL_M = 5;

/**
 * Cap on the grid side, and therefore on the texture.
 *
 * 2560^2 single-channel bytes is 6.25 MiB, the worst case, under the ~8 MB
 * this is allowed. What the four packs with roads actually get, and what
 * building the grid costs at load (measured, this machine, Bun):
 *
 *   emeraldhills  radius 6000  n 2400  5.00 m/texel  5.49 MiB  121 ms
 *   sf            radius 7000  n 2560  5.47 m/texel  6.25 MiB  326 ms
 *   chicago       radius 7000  n 2560  5.47 m/texel  6.25 MiB  394 ms
 *   manhattan     radius 8000  n 2560  6.25 m/texel  6.25 MiB  195 ms
 *
 * Only Manhattan is held by the cap, and 6.25 m still resolves a carriageway.
 */
const MAX_N = 2560;

/**
 * Full suppression reaches this far past the edge of the carriageway.
 *
 * The kerb and the gutter, plus slack for the centreline itself: OSM geometry
 * is accurate to a couple of metres in the suburbs, and the pack quantises to
 * quarter-metre offsets on top of that.
 *
 * It deliberately stops short of the whole PAVED envelope, which for a
 * residential street is 3.5 m of carriageway plus the 3.0 m of pavement in
 * PAVEMENT_WIDTH_M (data/pavement.ts), so 6.5 m. Suppressing out to there and
 * ramping beyond it would be the more physical model, and it is the wrong bet:
 * the pavement mesh already covers that ground wherever it is drawn, and the
 * failure mode of over-suppression is a dead grey band down every street in
 * the city, which is far more visible than a little grass near a kerb.
 */
export const KERB_MARGIN_M = 1.5;

/**
 * Metres over which grass ramps back to full strength beyond that.
 *
 * It has to be WIDER THAN A TEXEL or the ramp stops being the thing that
 * decides the edge and the GPU's bilinear reconstruction becomes it instead:
 * at 6.25 m/texel worst case, a fade of 6 m is about one texel of ramp on each
 * side, which is the least that still reads as a transition rather than as a
 * grid artefact. It is also about the width of an American planting strip, so
 * the lawn returns roughly where the front garden starts.
 */
export const VERGE_FADE_M = 6.0;

/**
 * Classes that get a mask. Everything with a carriageway, and nothing else.
 *
 * Footways, cycleways and tracks are excluded and that is the whole point of
 * having a list: they are 1.8 to 3 m strips, they thread through every park in
 * the map (footway is the most common class in all four packs, 48,883 of
 * Chicago's 76,952 ways), and a 25 m suppression band around each one would
 * strip the grass out of Golden Gate Park to fix a street in Emerald Hills.
 * Grass beside a park path is correct. Grass over a road is not.
 */
const HAS_CARRIAGEWAY: readonly boolean[] = (() => {
  const t = new Array<boolean>(14).fill(true);
  t[RoadClass.Footway] = false;
  t[RoadClass.Cycleway] = false;
  t[RoadClass.Track] = false;
  return t;
})();

export interface RoadCoverage {
  /** Coverage 0..255, row-major, n*n. */
  data: Uint8Array;
  n: number;
  /** Half-width in metres the grid spans about the scene origin. */
  extent: number;
}

/** Grid side for a pack of this radius. Separate so the check can print it. */
export function roadMaskSize(extentM: number): number {
  return Math.min(MAX_N, Math.max(256, Math.ceil((extentM * 2) / TARGET_CELL_M)));
}

/**
 * Coverage in [0,1] at a given distance from a centreline, for a road of this
 * width. The shape of the falloff, in one place, so the rasteriser and every
 * assertion about it cannot disagree.
 *
 * Deliberately not a binary test. A hard 0/1 would put a step at a texel edge,
 * which is the same failure as the one being fixed (grass ending on a line)
 * pointed the other way.
 */
export function coverageAtDistance(distM: number, widthM: number): number {
  const full = widthM * 0.5 + KERB_MARGIN_M;
  const reach = full + VERGE_FADE_M;
  if (distM <= full) return 1;
  if (distM >= reach) return 0;
  return (reach - distM) / VERGE_FADE_M;
}

/** Squared distance from (px,pz) to the segment (ax,az)-(bx,bz). */
function distSqToSegment(
  px: number, pz: number,
  ax: number, az: number, bx: number, bz: number,
): number {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  // A repeated vertex is a legal polyline and gives len2 = 0; without this the
  // division below is a NaN that poisons the whole texel.
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qz = az + t * dz - pz;
  return qx * qx + qz * qz;
}

/**
 * Rasterise the centrelines into a coverage grid.
 *
 * Sampled at TEXEL CENTRES, not area-averaged over the texel. Area coverage
 * would report a half-covered texel at 0.5 and leave grass down the middle of
 * a narrow street; the point sample of a flat-topped falloff reports 1 there,
 * because the ground under that texel centre really is tarmac.
 *
 * NOT blurred afterwards, and the instinct to blur "like urbanmask does" is
 * wrong for the same reason it is wrong in data/landmask.ts: urbanmask blurs
 * because street light genuinely spills past a block boundary, whereas this
 * field is already a smooth ramp by construction, and a 3x3 blur on top would
 * just widen every road by a texel and put the edge somewhere nobody chose.
 */
export function buildRoadCoverage(roads: readonly Road[], extentM: number): RoadCoverage {
  const n = roadMaskSize(extentM);
  const cell = (extentM * 2) / n;
  const data = new Uint8Array(n * n);

  for (const r of roads) {
    if (!HAS_CARRIAGEWAY[r.cls]) continue;
    const width = roadWidthM(r.cls, r.lanes, r.flags);
    const reach = width * 0.5 + KERB_MARGIN_M + VERGE_FADE_M;
    const reach2 = reach * reach;

    for (let i = 2; i < r.pts.length; i += 2) {
      const ax = r.pts[i - 2], az = r.pts[i - 1];
      const bx = r.pts[i], bz = r.pts[i + 1];

      // Texel index range covering the segment's bounding box grown by reach.
      // Segments are short (the baker emits a vertex every few tens of metres),
      // so this stays close to the swept area rather than degenerating into the
      // bbox of a whole road.
      const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) + extentM - reach) / cell));
      const gz0 = Math.max(0, Math.floor((Math.min(az, bz) + extentM - reach) / cell));
      const gx1 = Math.min(n - 1, Math.floor((Math.max(ax, bx) + extentM + reach) / cell));
      const gz1 = Math.min(n - 1, Math.floor((Math.max(az, bz) + extentM + reach) / cell));

      for (let gz = gz0; gz <= gz1; gz++) {
        const pz = (gz + 0.5) * cell - extentM;
        const row = gz * n;
        for (let gx = gx0; gx <= gx1; gx++) {
          const px = (gx + 0.5) * cell - extentM;
          const d2 = distSqToSegment(px, pz, ax, az, bx, bz);
          if (d2 >= reach2) continue;
          const v = Math.round(255 * coverageAtDistance(Math.sqrt(d2), width));
          // Roads overlap at junctions and along dual carriageways; the widest
          // claim on a texel wins, so a slip road cannot carve a gap out of the
          // motorway it leaves.
          if (v > data[row + gx]) data[row + gx] = v;
        }
      }
    }
  }

  return { data, n, extent: extentM };
}

/**
 * The bilinear filter the GPU will run, in JS: same texel centres, same
 * clamp-to-edge, same weights. Single-channel twin of sampleMaskBilinear in
 * data/landmask.ts, which is RGBA and cannot be shared without giving every
 * caller a stride argument to get wrong.
 *
 * This is what lets the check assert on geography rather than on texel indices.
 */
export function sampleRoadCoverage(
  cov: RoadCoverage,
  x: number,
  z: number,
): number {
  const { data, n, extent } = cov;
  const cell = (extent * 2) / n;
  const fx = (x + extent) / cell - 0.5;
  const fz = (z + extent) / cell - 0.5;
  const i0 = Math.floor(fx);
  const k0 = Math.floor(fz);
  const tx = fx - i0;
  const tz = fz - k0;
  const cl = (v: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);
  const i0c = cl(i0), i1c = cl(i0 + 1), k0c = cl(k0), k1c = cl(k0 + 1);
  return (
    (1 - tx) * (1 - tz) * data[k0c * n + i0c] +
    tx * (1 - tz) * data[k0c * n + i1c] +
    (1 - tx) * tz * data[k1c * n + i0c] +
    tx * tz * data[k1c * n + i1c]
  ) / 255;
}

export interface RoadMask {
  texture: THREE.DataTexture;
  /** Half-width in metres the texture spans about the scene origin. */
  extent: number;
  /** False for a city with no road pack, and the shader must then ignore it. */
  has: boolean;
  /** Metres per texel, for the load log. */
  cellM: number;
  bytes: number;
}

export function buildRoadMask(pack: RoadPack): RoadMask {
  const extent = Math.max(2000, pack.radiusM);
  const cov = buildRoadCoverage(pack.roads, extent);
  const texture = new THREE.DataTexture(
    cov.data, cov.n, cov.n, THREE.RedFormat, THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return {
    texture, extent, has: true,
    cellM: (extent * 2) / cov.n,
    bytes: cov.data.length,
  };
}

/**
 * No mask at all, for a city with no road pack.
 *
 * Only four cities have one, so this is the common case, and it has to leave
 * the terrain byte-identical to what it renders without any of this. The
 * single zero texel would already do that, but `has` is what the shader
 * actually gates on: a no-op by construction beats a no-op that holds only as
 * long as the data happens to be zero.
 */
export function emptyRoadMask(): RoadMask {
  const texture = new THREE.DataTexture(
    new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType,
  );
  texture.needsUpdate = true;
  return { texture, extent: 1, has: false, cellM: 0, bytes: 1 };
}
