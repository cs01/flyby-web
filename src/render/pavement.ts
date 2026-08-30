// Pavements: the raised, kerbed, concrete half of a street.
//
// WHY THIS EXISTS. render/roads.ts made the carriageway resolution-independent
// and everything BESIDE it stayed a satellite photograph at 0.47 m per pixel.
// From an aeroplane that is invisible; from the car camera at 1.5 m it is a
// bilinear-magnified blob carrying the shadows and the parked cars of whatever
// afternoon the satellite flew, contradicting the scene's own sun. This draws
// the strip between the kerb and the building line as geometry instead, which
// both removes that photograph from the near field and puts a 135 mm step where
// a step belongs.
//
// FOUR DECISIONS CARRY IT.
//
// **The kerb is a face, not a line.** A pavement drawn flat in a different
// grey is most of the cost and almost none of the effect. The step is what
// makes a street read as a street: its top catches the sky and its face is in
// shadow, and the eye reads the pair as a kerb before it reads any colour.
//
// **The strip opens at junctions.** A pavement generated along one road runs
// straight across every road it crosses unless something stops it, and a 135 mm
// slab laid across a crossroads is far worse than no pavement at all. A uniform
// grid over the carriageways (the same RoadIndex the trees use) answers "is
// this point on some other road" per cross-section, and the strip is emitted in
// runs of surviving stations.
//
// **The width chases the building line.** Where the .city footprints put a wall
// within a few metres of the kerb the pavement runs to it, so the drape between
// kerb and building disappears entirely rather than being narrowed. Where
// nothing is found, the class width stands and the back edge turns into verge
// that chases the ground, so the strip melts into the drape instead of ending
// in a cliff.
//
// **It is a ring round the camera, not a bubble round the city centre.** The
// first version kept pavements within a fixed radius of the pack origin, the
// way render/roads.ts ranges its classes, and that is wrong here for a reason
// worth writing down: a road ribbon fades out at 800 m and is still worth
// having 8 km from the centre because you can SEE it from the air, whereas a
// kerb is thrown away by the shader past 330 m and is only ever wanted where
// the camera is. A centre-relative radius big enough to cover a city is a
// budget nobody can afford, and one small enough to afford covers the wrong
// ground: the pinned street-level pose sits 2,474 m from the San Francisco
// origin and got no pavement at all. So the strips are built per tile, lazily,
// for the tiles near the camera, and dropped when it leaves. That is both far
// cheaper (a 850 m ring of San Francisco is about 40k triangles against the
// 1.9M a whole-city build would want) and correct everywhere.
//
// **The fade is the budget, exactly as in roads.ts.** A 135 mm kerb is under a
// pixel past a few hundred metres, so the first thing the fragment shader does
// is compute the distance fade and discard. It fades EARLIER than the road
// ribbons (170-330 m against 400-800 m) because it carries finer detail and
// because the aerial view must not change: at 420 m over the Loop every
// pavement fragment is killed by the first comparison in the shader.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import type { Budget } from "./budget";
import { SUN_SHADOW_GLSL, type SunShadowUniforms } from "./sunshadow";
import { SH_GLSL } from "./sh";
import { AO_GLSL } from "./ao";
import { makeRoadUniforms, type RoadUniforms } from "./roads";
import { RoadIndex } from "../data/trees";
import type { FootprintMask } from "../data/trees";
import {
  addPavement,
  emptyPavement,
  hasPavement,
  KERB_HEIGHT_M,
  PAVEMENT_STATION_M,
  PAVEMENT_RING_M,
  PAVEMENT_TILE_M,
  type PavementWorld,
} from "../data/pavement";
import {
  roadWidthM,
  ROAD_BRIDGE,
  ROAD_LIFT_M,
  ROAD_TUNNEL,
  RoadClass,
  type Road,
  type RoadPack,
} from "../data/roadpack";


/**
 * Where the pavement stops mattering, in metres from the lens.
 *
 * Tighter than the road ribbons on purpose; see the header. Anything past
 * uFadeFar costs one comparison and a killed fragment.
 */
const FADE_NEAR_M = 170;
const FADE_FAR_M = 330;

/**
 * How far the building-line search steps, and how far it is biased outward.
 *
 * The footprint mask is a 4 m grid, so the first occupied cell a ray meets
 * begins somewhere between the wall and 4 m short of it. Undershooting leaves a
 * band of drape against the wall, which is the exact thing this file exists to
 * remove; overshooting puts concrete a metre inside a building, where the wall
 * hides it. So the answer is biased outward by half a cell.
 */
const CLEARANCE_STEP_M = 1;
const CLEARANCE_BIAS_M = 2;

/**
 * Classes that block a pavement where they cross it.
 *
 * Everything a vehicle drives on, including the motorways and trunk roads that
 * get no pavement of their own: a footway laid across a freeway is the single
 * worst artefact this file could ship.
 */
function isCarriageway(r: Road): boolean {
  return r.cls <= RoadClass.Busway && (r.flags & (ROAD_TUNNEL | ROAD_BRIDGE)) === 0;
}


// --- shaders ----------------------------------------------------------------

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;    // x: metres along the centreline, y: metres out from the kerb
in vec4 info;  // face kind + 4 * side, outward normal x, outward normal z, width

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 uCameraPos;

out vec3 vWorld;
out vec2 vUv;
out vec4 vInfo;
out float vViewDist;

void main() {
  vWorld = position;
  vUv = uv;
  vInfo = info;
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld;
in vec2 vUv;
in vec4 vInfo;
in float vViewDist;
out vec4 fragColor;

// Aerial perspective only, the same short march the roads and the terrain use.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${SUN_SHADOW_GLSL}
${SH_GLSL}
${AO_GLSL}

uniform vec3  uCameraPos;
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform float uWetness;
uniform float uSnow;
uniform float uNight;
uniform vec3  uNightGlow;
uniform vec3  uMoonDir;
uniform vec3  uMoonLight;
uniform float uSunSurface;
uniform float uFadeNear;
uniform float uFadeFar;

const float KERB = ${KERB_HEIGHT_M.toFixed(4)};

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Value noise; see the note on the same function in roads.ts. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  // The fade, FIRST, and nothing else before it. At any altitude worth flying
  // this shader must cost one comparison, not a noise field and an atmosphere
  // integral. See the header.
  float fade = 1.0 - smoothstep(uFadeNear, uFadeFar, vViewDist);
  if (fade < 0.004) discard;

  // info.x carries the face kind and, four counts up, which side of the road
  // this strip is on. The side is only wanted for the street lamps, which have
  // to alternate in step with the ones render/roads.ts paints on the
  // carriageway, off the same u and the same hash.
  float side01 = step(3.5, vInfo.x);
  float kind = vInfo.x - side01 * 4.0;
  vec2 outward = vec2(vInfo.y, vInfo.z);
  float pw = max(vInfo.w, 0.3);

  float u = vUv.x;
  float t = vUv.y;
  vec2  w = vWorld.xz;
  bool isKerb = kind < 0.5;
  bool isOpen = kind > 1.5;

  // The geometric normal, from the derivatives of the world position.
  //
  // No normal attribute: a kerb face and the pavement behind it share their
  // arris, and a shared vertex normal would round the one edge the whole
  // feature exists for. The cross product is per-triangle and exact, and it
  // picks up the verge's tilt where the back edge chases the ground.
  vec3 g = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  vec3 want = isKerb ? vec3(-outward.x, 0.0, -outward.y) : vec3(0.0, 1.0, 0.0);
  vec3 n = g * sign(dot(g, want) + 1e-6);

  // Metres of world per pixel, taken on the world position for the reason
  // roads.ts spells out: fwidth of a fract()ed coordinate spikes at every seam.
  float px = max(fwidth(w.x), fwidth(w.y)) + 1e-5;
  float fineD  = 1.0 - smoothstep(0.03, 0.18, px);
  float jointD = 1.0 - smoothstep(0.06, 0.40, px);

  vec3 albedo;
  float roughness;

  if (isKerb) {
    // --- the kerb face ----------------------------------------------------
    // Granite, laid as stones about 1.15 m long. The joint between stones and
    // the worn arris at the top are what stop it reading as an extruded strip:
    // without them a kerb is a band of flat colour whatever height it is.
    float sIdx = floor(u / 1.15);
    albedo = mix(vec3(0.116, 0.118, 0.124), vec3(0.176, 0.174, 0.166),
                 hash11(sIdx * 3.7 + 1.3));
    float sf = abs(fract(u / 1.15) - 0.5);
    float aaJ = fwidth(u / 1.15) * 0.6 + 0.004;
    albedo *= 1.0 - 0.42 * smoothstep(0.5 - 0.016 - aaJ, 0.5 - 0.016 + aaJ, sf) * jointD;

    // t runs from -KERB at the channel to 0 at the top. The topmost 20 mm is
    // the arris, polished pale by every wheel that has ever clipped it; the
    // bottom 45 mm is the channel, where the grit and the oil collect.
    float up = t + KERB;
    albedo *= 1.0 + 0.38 * smoothstep(KERB - 0.022, KERB, up);
    albedo *= 1.0 - 0.42 * smoothstep(0.050, 0.004, up);
    // Vertical staining down the face, from the runoff off the pavement above.
    albedo *= 1.0 - 0.12 * smoothstep(0.35, 0.85, vnoise(vec2(u * 1.7, 0.5))) * fineD;
    roughness = 0.86;
  } else {
    // --- the pavement top -------------------------------------------------
    // Cast in bays and scored across. Every bay is a slightly different age,
    // because a pavement is repaired one slab at a time as roots heave it and
    // as the utilities dig it up, and that patchwork is the single layer that
    // does most for the look -- the same finding as the asphalt quilt in
    // roads.ts, for the same reason.
    const float SLAB = 1.45;
    // The 0.42 offset puts a joint line just behind the kerb rather than a bay
    // boundary landing on the arris at every station.
    vec2 sc = vec2(u / SLAB, (t + 0.42) / SLAB);
    vec2 si = floor(sc);
    // TWO scales of variation, not one. A per-slab hash alone reads as a
    // chessboard from the air -- the same failure the roof shader in
    // buildings.ts documents -- because every cell is independent. A pavement
    // is actually re-laid in STRETCHES of a few metres, so most of the
    // variation belongs to the run and only a little to the individual bay.
    float run = hash11(floor(u / 7.3) * 2.7 + 5.0);
    float age = hash21(si + 3.1);
    albedo = vec3(0.172, 0.169, 0.160) * (1.0 + (run - 0.5) * 0.20 + (age - 0.5) * 0.11);
    // Concrete batches drift warm and cool, and a street of one grey is a
    // street nobody built. Per RUN, for the same reason.
    albedo *= mix(vec3(1.03, 1.00, 0.96), vec3(0.97, 0.99, 1.04), hash11(floor(u / 7.3) * 9.1 + 2.0));

    vec2 sfv = abs(fract(sc) - 0.5);
    float aaS = max(fwidth(sc.x), fwidth(sc.y)) * 0.6 + 0.004;
    float joint = smoothstep(0.5 - 0.013 - aaS, 0.5 - 0.013 + aaS, max(sfv.x, sfv.y));
    // Joints vary: some are open and full of grit, some have been sealed.
    albedo *= 1.0 - (0.16 + 0.22 * hash21(si * 2.3 + 44.0)) * joint * jointD;

    // One bay in twenty has been dug up and made good in tarmac, and a black
    // rectangle in a grey field is worth more than any amount of noise.
    float repair = step(0.952, hash21(si * 5.3 + 61.0));
    albedo = mix(albedo, vec3(0.072, 0.070, 0.072), repair);
    roughness = mix(0.90, 0.84, repair);

    // Exposed aggregate, and the low-frequency dirt that collects on any
    // horizontal surface in a city. The dirt runs at two scales because at one
    // it reads as a pattern rather than as grime.
    albedo *= 1.0 + (vnoise(w * 24.0) - 0.5) * 0.20 * fineD;
    albedo *= 1.0 - 0.16 * smoothstep(0.30, 0.85, vnoise(w * 0.45 + 29.0));
    albedo *= 1.0 - 0.10 * smoothstep(0.40, 0.90, vnoise(w * 1.7 + 7.0)) * jointD;
    // Road grime creeps up the first half metre from the kerb, and rain off the
    // building stains the back of the footway where there is a building to
    // shed it. Both are strongest at the joints, where the water sits.
    albedo *= 1.0 - 0.20 * smoothstep(0.55, 0.0, t);

    // The kerb stone's own top face: the first 130 mm of the footway is the
    // granite, not the concrete. It is what makes the kerb read as a kerb from
    // directly above, where its face is edge-on and invisible.
    float kerbTop = smoothstep(0.145, 0.115, t);
    albedo = mix(albedo, vec3(0.118, 0.119, 0.122) * (0.85 + 0.4 * hash11(floor(u / 1.15) * 3.7 + 1.3)),
                 kerbTop * jointD);

    if (isOpen) {
      // Nothing to run up to, so the back of the strip is verge: soil, gravel,
      // weeds and whatever the last tenant dropped. Never one colour, and
      // never the same colour twice in a block.
      float band = smoothstep(pw - 1.1, pw - 0.15, t);
      float vh = vnoise(w * 0.30 + 5.0);
      vec3 verge = mix(vec3(0.084, 0.081, 0.058), vec3(0.140, 0.124, 0.084), vh);
      verge *= 1.0 + (vnoise(w * 2.6 + 71.0) - 0.5) * 0.55;
      albedo = mix(albedo, verge, band);
      roughness = mix(roughness, 0.98, band);
    }
  }

  // Snow lies on a pavement rather more than it does on a ploughed road.
  albedo = mix(albedo, vec3(0.86, 0.88, 0.92), uSnow * 0.55);
  // Wet concrete darkens, though less than wet asphalt does.
  albedo *= 1.0 - 0.34 * uWetness;

  // At night a dark-adapted eye takes almost no colour off a paving slab,
  // exactly as in the road and terrain shaders.
  if (uNight > 0.02) {
    float lum = dot(albedo, vec3(0.299, 0.587, 0.114));
    albedo = mix(albedo, vec3(mix(0.035, lum, 0.45)), uNight * 0.85);
  }

  // --- lighting, matched to the road it borders ---------------------------
  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl * sunVis;
  vec3 beam = direct + uMoonLight * uSunSurface * max(0.0, dot(n, uMoonDir));
  vec3 ambient = occludedSkyIrradiance(n);
  vec3 lit = albedo * (beam + ambient);

  // Wet concrete reflects the sky, weakly. Gated on wetness so the cube fetch
  // is paid for only on the frames it is actually raining.
  if (uWetness > 0.02) {
    vec3 vdir = normalize(uCameraPos - vWorld);
    vec3 refl = reflect(-vdir, n);
    vec3 env = textureLod(uEnv, refl, clamp(roughness, 0.0, 1.0) * uEnvMaxLod).rgb;
    float f = pow(1.0 - clamp(dot(vdir, n), 0.0, 1.0), 5.0);
    lit = mix(lit, env, (0.02 + 0.98 * f) * uWetness * 0.8);
  }

  // --- night --------------------------------------------------------------
  if (uNight > 0.02) {
    // The same 52 m rhythm, the same alternation and the same hash that
    // render/roads.ts uses for the carriageway lamps, off the same u -- so a
    // lamp lights the pavement it stands on and the road beside it, rather
    // than the two disagreeing about where the lamps are.
    const float SPACING = 52.0;
    float su = u / SPACING;
    float idx = floor(su);
    float onThisSide = step(abs(mod(idx, 2.0) - side01), 0.5);
    float du = (fract(su) - 0.5) * SPACING;
    float dt = t - 0.5;
    float bright = step(0.46, hash11(idx * 1.7 + 5.0)) * (0.45 + 0.9 * hash11(idx * 3.3));
    float pool = exp(-(du * du + dt * dt) * 0.018) * bright * onThisSide;
    float lampDetail = smoothstep(1.6, 0.35, px);
    pool = mix(min(0.22, 0.16), pool, lampDetail);
    vec3 lampCol = mix(vec3(0.85, 0.90, 1.0), vec3(1.0, 0.72, 0.36),
                       smoothstep(0.05, 0.6, hash11(idx * 9.1 + 2.0)));
    lit += lampCol * pool * uNight * (1.0 + 2.2 * uWetness) * 0.17;
    lit += albedo * uNightGlow * 0.9;
  }

  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);

  fragColor = vec4(lit * trans + inscatter, fade);
}
`;

export interface PavementStats {
  /** Tiles the pack has any kerbable carriageway in. Fixed at construction. */
  indexedTiles: number;
  /** Tiles resident right now. */
  tiles: number;
  /** Ways with a pavement in those tiles. */
  drawn: number;
  /** Triangles resident right now. */
  triangles: number;
  /** Tiles wanted but dropped because the triangle budget was full. */
  clipped: number;
  /** Milliseconds the last rebuild took, and the worst one seen. */
  lastBuildMs: number;
  worstBuildMs: number;
  /** Rebuilds so far. One per tile the camera has crossed. */
  rebuilds: number;
}

/** One built tile: the mesh in the group and what it cost. */
interface Tile {
  mesh: THREE.Mesh;
  triangles: number;
  ways: number;
}

export class Pavement {
  readonly group = new THREE.Group();
  readonly uniforms: RoadUniforms;
  readonly stats: PavementStats = {
    indexedTiles: 0, tiles: 0, drawn: 0, triangles: 0, clipped: 0,
    lastBuildMs: 0, worstBuildMs: 0, rebuilds: 0,
  };

  private readonly pack: RoadPack;
  private readonly world: PavementWorld;
  private readonly budgetTriangles: number;
  /** Way indices per tile, keyed by tile coordinates. Built once. */
  private readonly byTile = new Map<string, number[]>();
  private readonly tiles = new Map<string, Tile>();
  private atX = Number.NaN;
  private atZ = Number.NaN;

  constructor(
    pack: RoadPack,
    groundAt: (x: number, z: number) => number,
    footprints: FootprintMask | null,
    shadow: SunShadowUniforms,
    budget: Budget,
  ) {
    this.pack = pack;
    this.budgetTriangles = budget.pavementTriangleBudget;
    this.uniforms = makeRoadUniforms(shadow);
    this.uniforms.uFadeNear.value = FADE_NEAR_M;
    this.uniforms.uFadeFar.value = FADE_FAR_M;

    // What opens the pavement at a junction: every carriageway, padded by its
    // own half width, so a query answers "is this point on tarmac".
    const carriageways = pack.roads.filter(isCarriageway);
    const blockers = new RoadIndex(
      carriageways,
      (r) => roadWidthM(r.cls, r.lanes, r.flags) * 0.5,
    );

    this.world = {
      roadSurfaceY: (x, z) => groundAt(x, z) + ROAD_LIFT_M,
      groundY: groundAt,
      onCarriageway: (x, z) => blockers.blocked(x, z),
      clearanceM: (x, z, dx, dz, maxM) => {
        if (!footprints) return maxM;
        for (let d = 0; d <= maxM; d += CLEARANCE_STEP_M) {
          if (footprints.occupied(x + dx * d, z + dz * d)) {
            return Math.min(maxM, d + CLEARANCE_BIAS_M);
          }
        }
        return maxM;
      },
    };

    for (let i = 0; i < pack.roads.length; i++) {
      const r = pack.roads[i];
      if (!hasPavement(r)) continue;
      const key = tileKey(Math.floor(r.cx / PAVEMENT_TILE_M), Math.floor(r.cz / PAVEMENT_TILE_M));
      const list = this.byTile.get(key);
      if (list) list.push(i);
      else this.byTile.set(key, [i]);
    }
    this.stats.indexedTiles = this.byTile.size;
  }

  /**
   * Follow a camera. Safe to call every frame; it does nothing until the camera
   * has crossed into a different tile, which at 400 m is every eighteen seconds
   * at the car's top speed and never at all in a fixed pose.
   */
  update(camX: number, camZ: number): void {
    const tx = Math.floor(camX / PAVEMENT_TILE_M);
    const tz = Math.floor(camZ / PAVEMENT_TILE_M);
    if (tx === this.atX && tz === this.atZ) return;
    this.atX = tx;
    this.atZ = tz;

    const t0 = performance.now();
    const span = Math.ceil(PAVEMENT_RING_M / PAVEMENT_TILE_M) + 1;

    // Nearest tile first, so a city denser than the budget loses its outermost
    // ring rather than an arbitrary slice; the same rule render/trees.ts uses.
    const wanted: { key: string; x: number; z: number; d2: number }[] = [];
    for (let k = tz - span; k <= tz + span; k++) {
      for (let i = tx - span; i <= tx + span; i++) {
        const key = tileKey(i, k);
        if (!this.byTile.has(key)) continue;
        const x0 = i * PAVEMENT_TILE_M;
        const z0 = k * PAVEMENT_TILE_M;
        const dx = Math.max(0, Math.max(x0 - camX, camX - (x0 + PAVEMENT_TILE_M)));
        const dz = Math.max(0, Math.max(z0 - camZ, camZ - (z0 + PAVEMENT_TILE_M)));
        const d2 = dx * dx + dz * dz;
        if (d2 > PAVEMENT_RING_M * PAVEMENT_RING_M) continue;
        wanted.push({ key, x: x0, z: z0, d2 });
      }
    }
    wanted.sort((a, b) => a.d2 - b.d2);

    const keep = new Set<string>();
    let triangles = 0;
    let ways = 0;
    let clipped = 0;
    for (const w of wanted) {
      let tile: Tile | null = this.tiles.get(w.key) ?? null;
      if (!tile) {
        // The budget is checked BEFORE the build, against what is already
        // resident, so a dense city stops adding rings instead of building
        // geometry it then has to throw away.
        if (triangles >= this.budgetTriangles) { clipped++; continue; }
        tile = this.build(w.key);
        if (!tile) continue;
        this.tiles.set(w.key, tile);
        this.group.add(tile.mesh);
      }
      keep.add(w.key);
      triangles += tile.triangles;
      ways += tile.ways;
    }

    for (const [key, tile] of this.tiles) {
      if (keep.has(key)) continue;
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      (tile.mesh.material as THREE.Material).dispose();
      this.tiles.delete(key);
    }

    this.stats.tiles = keep.size;
    this.stats.drawn = ways;
    this.stats.triangles = triangles;
    this.stats.clipped = clipped;
    this.stats.lastBuildMs = performance.now() - t0;
    this.stats.worstBuildMs = Math.max(this.stats.worstBuildMs, this.stats.lastBuildMs);
    this.stats.rebuilds++;
  }

  /** Build one tile's strips, or null if everything in it was suppressed. */
  private build(key: string): Tile | null {
    const ids = this.byTile.get(key);
    if (!ids) return null;
    const s = emptyPavement();
    let ways = 0;
    for (const i of ids) {
      if (addPavement(s, this.pack.roads[i], this.world, PAVEMENT_STATION_M) > 0) ways++;
    }
    if (!s.idx.length) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(s.pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(s.uv, 2));
    geo.setAttribute("info", new THREE.Float32BufferAttribute(s.info, 4));
    const n = s.pos.length / 3;
    geo.setIndex(n > 65535
      ? new THREE.Uint32BufferAttribute(s.idx, 1)
      : new THREE.Uint16BufferAttribute(s.idx, 1));
    geo.computeBoundingSphere();

    const mat = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      // A kerb face is seen from the road and a pavement top from above, and
      // the two strips are emitted with one winding; the shader derives the
      // normal it wants from the geometry rather than from the winding.
      side: THREE.DoubleSide,
      transparent: true,
      // Same reasoning as the road ribbons: the strips are nearly coplanar with
      // the terrain they sit on, and letting them fight over a depth buffer is
      // how a street starts to flicker. Order alone decides what is on top.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -16,
    });

    const mesh = new THREE.Mesh(geo, mat);
    // After every road ribbon class (10..14 in roads.ts) and before the bridge
    // decks (15). The pavement never overlaps a carriageway, so drawing it last
    // among the surfaces costs nothing there; what it buys is that a mapped
    // footway lying in the pavement band does not paint an asphalt stripe down
    // the middle of the concrete.
    mesh.renderOrder = 14.5;
    return { mesh, triangles: s.idx.length / 3, ways };
  }

  /** Release the GPU memory this group holds; see Buildings.dispose. */
  dispose(): void {
    for (const tile of this.tiles.values()) {
      tile.mesh.geometry.dispose();
      (tile.mesh.material as THREE.Material).dispose();
    }
    this.tiles.clear();
    this.group.clear();
  }
}

function tileKey(x: number, z: number): string {
  return `${x},${z}`;
}
