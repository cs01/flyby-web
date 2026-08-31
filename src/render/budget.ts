// One place that decides what this device may be asked to render.
//
// Before this file, capability was decided in six places by three unrelated
// mechanisms: `pointer: coarse` (the drape plan, MSAA, ambient occlusion), the
// adaptive render scale (shadow cascades, the aircraft's probes) and two hard
// constants nothing ever scaled (the triangle budgets). Nothing computed a
// total, so nothing could answer the only question that matters on a phone
// rendering a black city: how much GPU memory is this load about to ask for.
//
// Two things follow from that, and both are why this module exists rather than
// a tidier version of the old scattering:
//
//   * The decision has to be made at LOAD. `AdaptiveQuality` reacts to about
//     thirty slow frames, and an allocation that fails during load never
//     produces a slow frame; it produces a corrupted or black one. The reactive
//     controller is kept and still scales things DOWN further, but it is now
//     subordinate: it can only reduce what was chosen here, never raise it.
//   * The total has to be an artefact, not an argument. `?diag=1` prints the
//     itemised estimate, because the owner's phone is the only instrument that
//     can see the failure and a screenshot of a number is the whole report.
//
// The decision logic is deliberately free of THREE and of the DOM so it can be
// gated under Bun; see test/budget.check.ts. `describeDevice()` is the only
// part that touches `navigator`.

/** Cap on the device pixel ratio, applied by render/renderer.ts.
 *
 * This renderer is fragment-bound (a full-screen atmosphere on every surface
 * plus a cloud march), so pixel count is very nearly the whole frame cost and
 * 2x on a Retina panel is 5.7 megapixels of it. The gain from 1.5 to 2 is small
 * and the cost is 78% more pixels. It lives here because the drawing buffer it
 * produces is the biggest single term in the memory estimate below. */
export const MAX_PIXEL_RATIO = 1.5;

export interface TerrainRing {
  /** Half-width in metres. */
  extent: number;
  /** Vertices per side. */
  segments: number;
  /** Imagery target zoom; higher is sharper. */
  imageryZoom: number;
}

/**
 * Ring plan for a city scene. The inner ring is the one the aircraft flies
 * through and gets DEM-native 30 m spacing; the outer ring exists so there are
 * mountains on the horizon and is allowed to be crude.
 */
export const CITY_RINGS: TerrainRing[] = [
  // A detail bubble for the ground close enough to look AT rather than fly
  // over. Zoom 16 is ~1.8 m per pixel, so from a few hundred feet the drape is
  // visibly made of texels and a road reads as a row of squares. Esri serves
  // imagery down to zoom 20 (verified live), and zoom 18 is ~0.47 m/px, which
  // is four times finer in each direction.
  //
  // The reason this ring is 400 m and not 2.2 km is texture memory, not tiles.
  // Drape cost grows as (extent x zoom)^2, and the growth is brutal: measured,
  // this ring stitches 64 tiles into 2048 px and ~17 MB, while zoom 18 over the
  // 2.2 km ring below would be ~1760 tiles, an 11264 px canvas and ~460 MB.
  //
  // It is therefore a bubble around the START point, not around the aircraft,
  // and you leave it in seconds at cruise. That is the right trade only
  // because the pixellation it fixes is a low-and-slow problem. Recentering
  // this ring as the camera moves is what ground vehicles will need.
  { extent: 400, segments: 128, imageryZoom: 18 },
  // THE GAP RING. Between the 400 m bubble and the 2.2 km ring there was a
  // step of two zoom levels, and it is the one you see: the ground goes from
  // sharp to smudged at the exact radius you are looking at from a few hundred
  // feet, and then visibly resolves as you fly into it.
  //
  // Zoom 17 is ~1.2 m a pixel. The reason this can afford it and the 400 m
  // bubble cannot afford to simply grow is which cost each pays. The bubble
  // RESTITCHES as the camera moves, so its cost is paid again every recentre:
  // taking it to 900 m makes that 96 MB a restitch, which is a stall you feel.
  // This ring is stitched once, and at 1.1 km it is ten tiles across -- a
  // 2560 px canvas, about 35 MB, the same order as the 2.2 km ring below it.
  { extent: 1100, segments: 192, imageryZoom: 17 },
  // The ring the aircraft actually flies through. At zoom 15 a street is
  // ~3.6 m per pixel, which is a smear; zoom 16 halves that and road markings,
  // car parks and pitch lines resolve. It is only 2.2 km across, so the extra
  // sharpness costs about a hundred tiles rather than thousands.
  { extent: 2200, segments: 224, imageryZoom: 16 },
  { extent: 6000, segments: 320, imageryZoom: 15 },
  { extent: 20000, segments: 256, imageryZoom: 13 },
  { extent: 70000, segments: 192, imageryZoom: 10 },
];

/**
 * The same plan, scaled down for a device that cannot hold the full one.
 *
 * Drape memory is decided at LOAD, before a single frame has been timed, so the
 * adaptive quality controller cannot help here: it reacts to slow frames, and a
 * phone that cannot fit these textures does not render slowly, it renders
 * CORRUPTED (garbled blocks, black geometry) or loses the context outright.
 *
 * Measured for the full plan at Chicago: 564 tiles and 148 MB of drape, ~197 MB
 * once mipmaps are counted, before shadow cascades, the facade lookup and the
 * landcover masks are added. That is a desktop budget.
 *
 * One zoom level down is a quarter of the pixels, so dropping the outer four
 * rings by a level takes the total to ~50 MB. The 400 m detail ring KEEPS its
 * zoom: it is the ground you are closest to, it is only 16.8 MB, and it is the
 * whole reason low-altitude flight stopped looking like a row of texels.
 */
export const MOBILE_CITY_RINGS: TerrainRing[] = [
  { extent: 400, segments: 96, imageryZoom: 18 },
  // The gap ring, one level down like everything else on this plan.
  { extent: 1100, segments: 144, imageryZoom: 16 },
  { extent: 2200, segments: 160, imageryZoom: 15 },
  { extent: 6000, segments: 224, imageryZoom: 14 },
  { extent: 20000, segments: 192, imageryZoom: 12 },
  { extent: 70000, segments: 160, imageryZoom: 9 },
];

/**
 * Everything the classifier is allowed to look at.
 *
 * A plain object with no browser types in it, because the whole point is that
 * the decision can be reproduced in a test from a made-up phone.
 */
export interface DeviceDescriptor {
  /** `pointer: coarse`, which answers "is this flown with thumbs". */
  coarsePointer: boolean;
  /**
   * `navigator.deviceMemory`: Chromium-only, whole gigabytes. It used to be
   * capped at 8 and is not any more (Chrome 151 on an M4 reports 16), so treat
   * it as a lower bound with an unknown ceiling. `null` means the browser did
   * not report it at all, which is NOT the same as plenty; see
   * `assumedMemoryGb`.
   */
  deviceMemoryGb: number | null;
  /** GL `MAX_TEXTURE_SIZE`, or `null` when no context could be probed. */
  maxTextureSize: number | null;
  /** Pixels the renderer will actually draw, after `MAX_PIXEL_RATIO`. */
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  /** The capped ratio itself, so the renderer does not recompute the cap. */
  pixelRatio: number;
}

export type QualityTier = "full" | "reduced";

/** One consumer of GPU memory, so the total can be argued with rather than trusted. */
export interface MemoryItem {
  what: string;
  bytes: number;
}

export interface MemoryEstimate {
  items: MemoryItem[];
  totalBytes: number;
}

export interface Budget {
  tier: QualityTier;
  /** What was decided FROM, kept so the panel can show the inputs and the outputs together. */
  device: DeviceDescriptor;
  /** Every rule that fired, not just the first, so the panel says WHY. */
  reasons: string[];
  /** What the classifier decided to believe about system memory. */
  assumedMemoryGb: number;
  rings: TerrainRing[];
  /** Samples on the offscreen scene target. 0 disables MSAA. */
  msaaSamples: number;
  /** Edge length of one sun shadow cascade. */
  shadowCascadeSize: number;
  /** Cascades fitted and rendered per frame; see SHADOW_CASCADE_SLOTS. */
  shadowCascadeCount: number;
  /** Cube face size of the aircraft's environment probe. */
  aircraftEnvSize: number;
  /** Edge length of the aircraft's self-shadow map. */
  aircraftShadowSize: number;
  aoEnabled: boolean;
  buildingTriangleBudget: number;
  roadTriangleBudget: number;
  pavementTriangleBudget: number;
  /** Street lamp columns resident at once. */
  lampInstanceBudget: number;
  /** Moving cars resident at once. */
  trafficInstanceBudget: number;
  /** Parked cars resident at once. */
  parkedInstanceBudget: number;
  memory: MemoryEstimate;
}

/**
 * At or below this many gigabytes, the full plan is not offered.
 *
 * Four is the line the drape plan already drew before this module existed, and
 * it is kept rather than re-derived: a 4 GB device shares that memory with the
 * compositor and the rest of the browser, and the full plan's estimate below is
 * comfortably more than a browser tab is entitled to on one.
 */
const SMALL_MEMORY_GB = 4;

/**
 * What to assume when `navigator.deviceMemory` is absent.
 *
 * Absent means the browser does not implement it, and the browsers that do not
 * are Safari and Firefox. On a coarse-pointer device that population is iPhones
 * and Firefox on Android, which is not a big-memory population, so absence
 * there is read as SMALL. On a device with a mouse it is read as plenty,
 * because the population is desktop Safari and desktop Firefox.
 *
 * The asymmetry is the point. A desktop wrongly given the reduced plan sees a
 * softer horizon; a phone wrongly given the full plan sees a broken picture.
 *
 * Eight for the fine-pointer case is "enough", not "the maximum": the reported
 * value is no longer capped at 8, so this is only ever used to clear the small
 * threshold below, never as a quantity anything is scaled against.
 */
const UNKNOWN_MEMORY_COARSE_GB = 3;
const UNKNOWN_MEMORY_FINE_GB = 8;

/**
 * Latitude the drape estimate is computed at.
 *
 * Tile count depends on latitude (Web Mercator tiles cover less ground the
 * further from the equator), and the classifier is deliberately not told which
 * city is about to load, so it estimates at one. The cities that ship sit
 * between 37 and 42 degrees; at 42 the estimate reproduces the measured Chicago
 * figure (see CITY_RINGS above) to within about half a percent, and it is an
 * over-estimate for anything nearer the equator, which is the safe direction.
 */
const NOMINAL_LATITUDE_DEG = 42;

/** Imagery is stitched over a bbox 5% larger than the ring; see main.ts. */
const DRAPE_MARGIN = 1.05;

/** ESRI serves 256 px tiles; see data/imagery.ts. */
const TILE_PX = 256;

/**
 * Degrees of longitude per metre at the equator, matching `bboxAround` in
 * data/dem.ts. Duplicated rather than imported because data/dem.ts pulls in the
 * IndexedDB tile cache, and this module has to load under Bun.
 */
const M_PER_DEG_LON = 111412;

/**
 * Shadow cascade slots that are always ALLOCATED, whatever the tier renders.
 *
 * The shader samples three cascade maps unconditionally, so three textures have
 * to be bound even when only two are fitted; `shadowCascadeCount` controls how
 * many are rendered into, not how many exist. The estimate has to count what is
 * allocated, not what is drawn, or it would under-report exactly the thing it
 * exists to report.
 */
const SHADOW_CASCADE_SLOTS = 3;

// --- byte costs -------------------------------------------------------------
//
// Every figure below is a per-texel or per-triangle size taken from the format
// the allocating code actually asks for. They are ESTIMATES in two senses that
// a reader should hold on to:
//
//   * A driver may pad, may store a depth texture as D24S8 rather than D24, and
//     may keep a shadow copy of a texture in system memory. Nothing here can
//     see that, so the true figure is a bit higher than this one, never lower.
//   * The geometry terms assume the triangle budgets are actually spent. They
//     usually are, since the LOD solver in buildings.ts and roads.ts raises
//     aggression until the count fits, so the budget is a ceiling that gets
//     approached from below.
//
// The number is therefore for comparing two plans and for spotting an order of
// magnitude, not for predicting an allocation failure to the megabyte.

/** RGBA8 drape texel. */
const DRAPE_BYTES_PER_TEXEL = 4;
/** A full mip chain is 4/3 of the base level. */
const MIPMAP_FACTOR = 4 / 3;
/** Scene target: RGBA16F colour plus a 32-bit depth texture. */
const SCENE_BYTES_PER_PIXEL = 8 + 4;
/** Shadow cascade: 32-bit depth texture plus the R8 colour attachment three insists on. */
const SHADOW_BYTES_PER_TEXEL = 4 + 1;
/** Aircraft env probe: RGBA16F, six faces, mipmapped. */
const ENV_BYTES_PER_TEXEL = 8;
/** Aircraft self-shadow: 32-bit depth texture plus an RGBA8 colour attachment. */
const AIRCRAFT_SHADOW_BYTES_PER_TEXEL = 4 + 4;
/** AO runs at half resolution in each axis: a depth target plus two RGBA16F targets. */
const AO_SCALE = 0.5;
const AO_BYTES_PER_PIXEL = (4 + 1) + 8 + 8;
/**
 * Building geometry, per triangle.
 *
 * A vertex is position + normal + uv + info = 12 floats = 48 bytes, and the
 * index is 32-bit. Walls are flat-shaded quads (4 vertices for 2 triangles) and
 * roofs are fans (n vertices for n-2 triangles), and walls outnumber roof
 * triangles two to one, so the mix comes out near 1.7 vertices per triangle.
 */
const BUILDING_BYTES_PER_TRIANGLE = 1.7 * 48 + 3 * 4;
/**
 * Road geometry, per triangle. A ribbon is a strip: 2 vertices per quad of 2
 * triangles, so one vertex per triangle, at position + uv + info = 36 bytes.
 */
const ROAD_BYTES_PER_TRIANGLE = 36 + 3 * 4;
/**
 * Pavement geometry, per triangle.
 *
 * Two strips per side sharing their cross-sections: four vertices per station
 * and four triangles per interval, so one vertex per triangle at position + uv
 * + info = 36 bytes, and six indices per four triangles.
 */
const PAVEMENT_BYTES_PER_TRIANGLE = 36 + 1.5 * 4;
/**
 * Street furniture and traffic, per INSTANCE rather than per triangle.
 *
 * Instanced fields invert the usual accounting: the base mesh is uploaded once
 * (a car is ~80 triangles and there are four archetypes, so under 30 KB in
 * total) and the resident cost is the per-instance attributes, allocated once
 * at capacity and never grown. A lamp carries two vec4s and a car carries two
 * vec4s and a vec2; see render/instanced.ts for why it is vec4s and not a mat4.
 *
 * Counting instances also makes the line item say the useful thing. "4,000 cars"
 * is a number the owner can argue with; "320k triangles of car" is not.
 */
const LAMP_BYTES_PER_INSTANCE = 2 * 16;
const CAR_BYTES_PER_INSTANCE = 2 * 16 + 8;
/** Base meshes, uploaded once each and shared by every instance. */
const STREET_BASE_MESH_BYTES = 64 * 1024;

/**
 * Headroom on each car archetype's share of the car budget.
 *
 * The cars are drawn from four archetype meshes, so the budget is split four
 * ways and each split is allocated at its own fixed size. An EVEN split is
 * wrong, and quietly: the archetype is a hash, so the four counts are a
 * multinomial and land within a couple of per cent of each other, which is
 * exactly close enough to the cap for one of them to go over. Measured on the
 * `sf-residential` pose, the four parked buckets wanted 883, 969, 881 and 929
 * against an even cap of 875, and 185 parked cars were dropped with nothing
 * said about it.
 *
 * A quarter of headroom covers a spread far wider than a hash produces, and it
 * is counted HERE, in the memory estimate, so the allocation the tier makes and
 * the allocation this file reports are the same number.
 */
export const CAR_BUCKET_HEADROOM = 1.25;

/**
 * What the classifier believes about system memory.
 *
 * Separate from the tier rules and exported because it is the one place an
 * absent `deviceMemory` is turned into a number, and turning it into the wrong
 * number (8, "plenty") is the mistake that puts a phone on the desktop plan.
 */
export function assumedMemoryGb(d: DeviceDescriptor): number {
  if (d.deviceMemoryGb !== null) return d.deviceMemoryGb;
  return d.coarsePointer ? UNKNOWN_MEMORY_COARSE_GB : UNKNOWN_MEMORY_FINE_GB;
}

/**
 * Widest drape texture a ring plan needs, in pixels.
 *
 * A device whose `MAX_TEXTURE_SIZE` is under this cannot upload the plan at
 * all: the stitched canvas is one texture per ring.
 */
export function widestDrapeTexturePx(rings: TerrainRing[]): number {
  let widest = 0;
  for (const ring of rings) widest = Math.max(widest, drapeTilesAcross(ring) * TILE_PX);
  return widest;
}

/**
 * Tiles the stitcher will lay across one ring, in one axis.
 *
 * `floor(span / tile) + 1` rather than `ceil`, because the stitcher snaps to
 * whole tiles from wherever the bbox edges happen to fall: the count is the
 * difference of two floors, whose expectation is exactly this. Checked against
 * the measured Chicago figure, 561 tiles predicted against 564 counted.
 */
function drapeTilesAcross(ring: TerrainRing): number {
  const spanM = 2 * ring.extent * DRAPE_MARGIN;
  const cosLat = Math.cos((NOMINAL_LATITUDE_DEG * Math.PI) / 180);
  const tileM = (M_PER_DEG_LON * cosLat * 360) / 2 ** ring.imageryZoom;
  return Math.floor(spanM / tileM) + 1;
}

/**
 * The extra drape a ground vehicle's moving detail ring costs.
 *
 * render/detailring.ts stitches the innermost ring again around the car and
 * swaps it in atomically, which means that for the length of one swap BOTH
 * copies are resident: the old one is still being drawn and the new one has
 * already been uploaded. The estimate has to carry that second copy or it
 * under-reports the peak by the biggest single texture in the plan, on the
 * device least able to absorb it.
 */
export function detailRestitchBytes(rings: TerrainRing[]): number {
  return rings.length > 0 ? drapeBytes([rings[0]]) : 0;
}

function drapeBytes(rings: TerrainRing[]): number {
  let bytes = 0;
  for (const ring of rings) {
    const px = drapeTilesAcross(ring) * TILE_PX;
    bytes += px * px * DRAPE_BYTES_PER_TEXEL * MIPMAP_FACTOR;
  }
  return bytes;
}

/** Everything a tier decides, before the memory estimate is attached. */
type Plan = Omit<Budget, "tier" | "device" | "reasons" | "assumedMemoryGb" | "memory">;

const FULL_PLAN: Plan = {
  rings: CITY_RINGS,
  msaaSamples: 4,
  shadowCascadeSize: 2048,
  shadowCascadeCount: 3,
  aircraftEnvSize: 128,
  aircraftShadowSize: 1024,
  aoEnabled: true,
  // Cities differ in density by more than a factor of five (San Francisco bakes
  // to 62k buildings and Manhattan to 187k over a similar radius), so a fixed
  // LOD curve is either wasteful or unaffordable. Solving the curve against a
  // budget makes frame cost a property of the renderer rather than of whichever
  // city was loaded, and the budget is now a property of the DEVICE.
  // Four million, not one and a half, and Paris is why.
  //
  // The LOD solver raises its cutoff until the whole city fits the budget, so
  // the budget decides how much of a city you can see. Paris has 181,205
  // footprints averaging 11.8 vertices (46% have ten corners or more, because
  // Haussmann blocks are courtyards rather than boxes) against Manhattan's 7.3,
  // so at 1.5M it escalated to k=3 and culled everything short: the city
  // rendered as bare drape with a dozen towers standing in it.
  //
  // The old figure predated the measurement that geometry is the cheap half of
  // this renderer. At 4M, Paris draws 3.3M triangles at k=1.4 and Manhattan
  // improves from k=1.4 to k=1. Measured cost: Manhattan 7.9 to 9.7 ms, Paris
  // 5.6 to 10.2 ms, and Paris was drawing almost nothing at 5.6.
  //
  // Most of that is not vertex work, it is the fragments those buildings then
  // shade, which is the scarce resource. So this is not free and should not be
  // raised again without the same before/after measurement.
  buildingTriangleBudget: 4_000_000,
  roadTriangleBudget: 700_000,
  // Pavements are a NEAR-FIELD feature: the fragment shader throws every one of
  // them away past 330 m, so this budget buys ground the car can drive over
  // before the detail drape restitches, not skyline. A quarter of the road
  // budget covers about two kilometres of San Francisco at full density.
  pavementTriangleBudget: 260_000,
  // Measured over a 950 m ring on Chicago's Loop: about 1,500 columns, at 36
  // triangles each. The headroom is for Manhattan, which has half again the
  // road length per square kilometre.
  lampInstanceBudget: 3_000,
  // A 1,500 m ring is 7 square kilometres of city. Manhattan runs roughly 20 km
  // of driveable centreline per square kilometre and the class table averages
  // about 22 cars per kilometre per lane over two lanes, which lands near 6,200;
  // this is that with room to spare, and the ring drops its outermost tiles
  // rather than growing past it.
  trafficInstanceBudget: 9_000,
  // A 340 m ring at both kerbs of every parkable street, 6.4 m a bay, 62%
  // occupied. Measured at 3,662 over the Marina, which is the densest street
  // grid in the set; 3,500 was the first figure and it clipped there.
  parkedInstanceBudget: 4_200,
};

const REDUCED_PLAN: Plan = {
  rings: MOBILE_CITY_RINGS,
  // The multisampled colour buffer is four times the size of the target it
  // resolves into, on the device that can least afford it.
  msaaSamples: 0,
  shadowCascadeSize: 1024,
  // The outermost cascade draws the whole city a third time and carries the
  // least visible detail, so it is what goes first.
  shadowCascadeCount: 2,
  aircraftEnvSize: 64,
  aircraftShadowSize: 512,
  // AO costs a full-geometry depth prepass plus two more RGBA16F targets, on a
  // device that already draws the caster set several times a frame. Its own
  // measurement says a street-level camera finds occlusion on 7% of the buffer,
  // so the device that can least afford it gains the least from it.
  aoEnabled: false,
  // Half, which is the same factor the rest of this plan lands on. The LOD
  // solver spends whatever it is given, so this is the term that keeps the
  // geometry estimate below from being the largest line on a phone.
  buildingTriangleBudget: 750_000,
  roadTriangleBudget: 350_000,
  pavementTriangleBudget: 110_000,
  // Halved along with the rest of the plan, on top of ring radii that are
  // already halved in render/streetlamps.ts and render/traffic.ts. Both cuts
  // are needed: the ring alone would leave the near field, where the fragments
  // are, exactly as dense as a desktop's.
  lampInstanceBudget: 1_200,
  trafficInstanceBudget: 3_000,
  parkedInstanceBudget: 1_500,
};

const PLANS: Record<QualityTier, Plan> = { full: FULL_PLAN, reduced: REDUCED_PLAN };

/**
 * Itemised GPU memory for a plan on a device. See the byte-cost block above for
 * what this can and cannot be trusted to say.
 */
function estimateMemory(plan: Plan, d: DeviceDescriptor): MemoryEstimate {
  const w = d.drawingBufferWidth;
  const h = d.drawingBufferHeight;
  const aoW = Math.max(1, Math.floor(w * AO_SCALE));
  const aoH = Math.max(1, Math.floor(h * AO_SCALE));

  const items: MemoryItem[] = [
    { what: "drape rings", bytes: drapeBytes(plan.rings) },
    {
      what: `scene target ${w}x${h} msaa ${plan.msaaSamples}`,
      // MSAA adds one multisampled colour and one multisampled depth buffer
      // alongside the single-sampled target they resolve into.
      bytes: w * h * SCENE_BYTES_PER_PIXEL * (1 + plan.msaaSamples),
    },
    {
      what: `shadow cascades ${SHADOW_CASCADE_SLOTS}x${plan.shadowCascadeSize}`,
      bytes: SHADOW_CASCADE_SLOTS * plan.shadowCascadeSize ** 2 * SHADOW_BYTES_PER_TEXEL,
    },
    {
      what: `aircraft env probe ${plan.aircraftEnvSize}`,
      bytes: 6 * plan.aircraftEnvSize ** 2 * ENV_BYTES_PER_TEXEL * MIPMAP_FACTOR,
    },
    {
      what: `aircraft self-shadow ${plan.aircraftShadowSize}`,
      bytes: plan.aircraftShadowSize ** 2 * AIRCRAFT_SHADOW_BYTES_PER_TEXEL,
    },
    {
      what: `ambient occlusion ${plan.aoEnabled ? `${aoW}x${aoH}` : "off"}`,
      bytes: plan.aoEnabled ? aoW * aoH * AO_BYTES_PER_PIXEL : 0,
    },
    {
      what: `detail ring restitch ${plan.rings[0].extent} m z${plan.rings[0].imageryZoom}`,
      bytes: detailRestitchBytes(plan.rings),
    },
    {
      what: `building geometry ${(plan.buildingTriangleBudget / 1000).toFixed(0)}k tris`,
      bytes: plan.buildingTriangleBudget * BUILDING_BYTES_PER_TRIANGLE,
    },
    {
      what: `road geometry ${(plan.roadTriangleBudget / 1000).toFixed(0)}k tris`,
      bytes: plan.roadTriangleBudget * ROAD_BYTES_PER_TRIANGLE,
    },
    {
      what: `pavement geometry ${(plan.pavementTriangleBudget / 1000).toFixed(0)}k tris`,
      bytes: plan.pavementTriangleBudget * PAVEMENT_BYTES_PER_TRIANGLE,
    },
    {
      what: `street lamps ${plan.lampInstanceBudget} instances`,
      bytes: plan.lampInstanceBudget * LAMP_BYTES_PER_INSTANCE + STREET_BASE_MESH_BYTES,
    },
    {
      what: `cars ${plan.trafficInstanceBudget} moving + ${plan.parkedInstanceBudget} parked`,
      bytes:
        (plan.trafficInstanceBudget + plan.parkedInstanceBudget) *
          CAR_BYTES_PER_INSTANCE * CAR_BUCKET_HEADROOM +
        STREET_BASE_MESH_BYTES,
    },
  ];

  let totalBytes = 0;
  for (const item of items) totalBytes += item.bytes;
  return { items, totalBytes };
}

/** The budget a named tier produces on this device, whatever tier it would be given. */
export function budgetForTier(tier: QualityTier, d: DeviceDescriptor): Budget {
  const plan = PLANS[tier];
  return {
    tier,
    device: d,
    reasons: [],
    assumedMemoryGb: assumedMemoryGb(d),
    ...plan,
    memory: estimateMemory(plan, d),
  };
}

/**
 * Classify a device and derive every number that follows from it.
 *
 * Pure: same descriptor in, same budget out, no reads of anything global. Every
 * rule that fires is recorded, not just the first, because the rules overlap on
 * purpose and "which of them caught this phone" is the interesting half of a
 * diagnostic screenshot.
 */
export function classifyDevice(d: DeviceDescriptor): Budget {
  const reasons: string[] = [];
  const memGb = assumedMemoryGb(d);

  if (d.coarsePointer) reasons.push("pointer is coarse");
  if (memGb <= SMALL_MEMORY_GB) {
    const how = d.deviceMemoryGb === null ? "assumed" : "reported";
    reasons.push(`memory ${how} ${memGb} GB, at or below ${SMALL_MEMORY_GB} GB`);
  }
  const needPx = widestDrapeTexturePx(CITY_RINGS);
  if (d.maxTextureSize !== null && d.maxTextureSize < needPx) {
    reasons.push(`MAX_TEXTURE_SIZE ${d.maxTextureSize} below the ${needPx} px the full drape needs`);
  }

  const budget = budgetForTier(reasons.length > 0 ? "reduced" : "full", d);
  budget.reasons = reasons;
  return budget;
}

// --- the browser half -------------------------------------------------------

/**
 * Read the descriptor off this browser.
 *
 * `MAX_TEXTURE_SIZE` needs a GL context and this runs before the renderer
 * exists, so it opens a throwaway one and drops it immediately: a leaked
 * context on a device with a small context budget would be its own version of
 * the bug this module is here to prevent.
 */
export function describeDevice(): DeviceDescriptor {
  const coarsePointer =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  const reported =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as { deviceMemory?: number }).deviceMemory;

  const ratio = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, MAX_PIXEL_RATIO);

  return {
    coarsePointer,
    deviceMemoryGb: typeof reported === "number" ? reported : null,
    maxTextureSize: probeMaxTextureSize(),
    drawingBufferWidth: Math.round(innerWidth * ratio),
    drawingBufferHeight: Math.round(innerHeight * ratio),
    pixelRatio: ratio,
  };
}

function probeMaxTextureSize(): number | null {
  if (typeof document === "undefined") return null;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const size = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return size;
  } catch {
    // No WebGL2 at all is a finding the diagnostics panel reports separately;
    // here it just means the texture rule has nothing to say.
    return null;
  }
}

let cached: Budget | null = null;

/**
 * The budget for this session, decided once.
 *
 * Memoised because the diagnostics panel asks for it before the renderer
 * exists and the renderer asks for it again afterwards, and a classification
 * that could differ between those two calls would be worse than no
 * classification at all.
 */
export function deviceBudget(): Budget {
  if (cached === null) cached = classifyDevice(describeDevice());
  return cached;
}

/** Mebibytes, one decimal, for the diagnostics panel. */
export function formatMiB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
