// The ground: nested LOD rings meshed from the heightfield and draped with
// satellite imagery.
//
// Three concentric rings rather than a quadtree. The scene is bounded (a city
// and its surroundings, not a planet), so LOD can be decided ONCE at load from
// distance-to-centre instead of re-evaluated per frame against the camera. That
// removes the entire class of bugs where a quadtree re-splits mid-flight and
// pops, and it costs nothing: the rings total ~140k vertices, which a phone
// draws without noticing.
//
// Ring boundaries crack, because the coarse side samples the height field at a
// different rate than the fine side. The fix is skirts: every ring edge drops a
// vertical curtain 400 m straight down. It is invisible from above (the drape
// continues over it) and it is the standard fix precisely because trying to
// stitch matching edge vertices between levels is a nightmare that fails the
// moment either level changes.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import { TONEMAP_GLSL } from "./tonemap.glsl";
import type { Heightfield } from "../data/dem";
import type { StitchedImage } from "../data/imagery";
import { Origin } from "../geo";

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
  { extent: 6000, segments: 384, imageryZoom: 15 },
  { extent: 20000, segments: 256, imageryZoom: 13 },
  { extent: 70000, segments: 192, imageryZoom: 10 },
];

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
in vec3 normal;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec3 uCameraPos;
out vec2 vUv;
out vec3 vNormal;
out vec3 vWorld;
out float vViewDist;
void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  vWorld = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDist = length(position - uCameraPos);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vNormal;
in vec3 vWorld;
in float vViewDist;
out vec4 fragColor;

// Aerial perspective only: a shorter march than the sky uses. See the note in
// atmosphere.glsl.ts -- this is per-fragment with overdraw, and it is smooth.
#define ATMO_STEPS 7
#define ATMO_SUN_STEPS 2
${ATMOSPHERE_GLSL}
${TONEMAP_GLSL}

uniform sampler2D uDrape;
uniform vec3  uCameraPos;
uniform vec3  uAmbient;
uniform float uWetness;
uniform float uSnow;
uniform float uNight;
uniform float uSunSurface;
uniform float uDebug;
uniform vec3 uNightGlow;
uniform sampler2D uUrban;
uniform float uUrbanExtent;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 albedo = srgbToLinear(texture(uDrape, vUv).rgb);
  vec3 n = normalize(vNormal);

  // Snow settles on flat ground and slides off anything steep. The slope test
  // is what keeps a snowy city from looking like it was dipped in paint.
  float flat_ = smoothstep(0.55, 0.85, n.y);
  albedo = mix(albedo, vec3(0.92, 0.94, 0.98), uSnow * flat_);

  // Wet ground is darker and shinier. Both, or it reads as mud.
  albedo *= (1.0 - 0.42 * uWetness);

  float ndl = max(0.0, dot(n, uSunDir));
  vec3 sunT = sunTransmittance(atmoOrigin(max(0.0, vWorld.y)), uSunDir, uTurbidity);
  // uSunIntensity is the scale the ATMOSPHERE integral wants: it gets multiplied
  // by scattering coefficients of order 1e-5, so it is ~16 and that is correct
  // there. uSunSurface converts it to the irradiance a surface receives.
  //
  // It is not 1/PI. A true 1/PI puts direct at ~4.3, which saturates the tone
  // curve to flat white on its own -- measured, by rendering the direct term by
  // itself. The value below is what makes a mid-albedo surface land in the
  // middle of the curve while leaving inscatter at the level the same
  // atmosphere produces, so aerial perspective stays proportionate.
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl;

  // Sky ambient, weighted by how much sky the surface can see. A valley floor
  // is darker than a ridge for the same sun angle, which is most of what makes
  // terrain read as three-dimensional at low sun.
  vec3 ambient = uAmbient * (0.55 + 0.45 * n.y);

  vec3 lit = albedo * (direct + ambient);

  // Specular sheen on wet ground, and always on water (which the drape shows
  // as dark blue; using luminance as a water proxy is crude but it is right
  // far more often than it is wrong, and it costs one texture read).
  // Water is identified by ELEVATION, not by colour.
  //
  // The obvious test -- "this pixel is dark, so it is water" -- does not work
  // on real satellite imagery: Esri's ocean is a mid blue-grey well above any
  // threshold that excludes dark roofs and shadowed streets, so the test never
  // fired and the sea rendered as flat lit ground. Elevation is unambiguous
  // here because the DEM decoder clamps everything below sea level to exactly
  // zero, which makes open water a plateau at 0 m. The soft ramp gives a
  // natural shoreline, since a 30 m DEM posting interpolates across the coast.
  float water = smoothstep(1.6, 0.25, vWorld.y);
  float gloss = max(uWetness, water);
  vec3 v = normalize(uCameraPos - vWorld);
  if (gloss > 0.01) {
    vec3 hv = normalize(v + uSunDir);
    float spec = pow(max(0.0, dot(n, hv)), mix(48.0, 320.0, water));
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * spec * gloss * 1.6;
  }

  // Open water is not a dark diffuse surface. Its colour is almost entirely
  // FRESNEL: looking straight down it is nearly black (you see the 0.02
  // reflectance and a little subsurface blue-green), and at a grazing angle it
  // becomes a mirror of the sky. That angular swing is what makes water read as
  // water, and no amount of tinting a diffuse albedo reproduces it.
  if (water > 0.01) {
    float f = pow(1.0 - clamp(dot(v, n), 0.0, 1.0), 5.0);
    float fres = 0.02 + 0.98 * f;
    vec3 deep = vec3(0.004, 0.016, 0.030) * (direct + ambient);
    vec3 skyRefl = uAmbient * 1.7 + uSunColor * uSunIntensity * uSunSurface * sunT * 0.10;
    lit = mix(lit, mix(deep, skyRefl, fres), water);
  }

  // City lights at night, keyed to how built-up the drape looks. Grey, bright
  // and low-saturation pixels are roads and roofs; vegetation and water are not.
  if (uNight > 0.01) {
    // Street lighting, gated by the URBAN MASK -- a coverage grid built from the
    // actual building footprints, not inferred from the daylight drape. The
    // drape cannot answer "is this built up": it is bright and desaturated over
    // beach, bare hill and runway alike, so every threshold either lit the whole
    // map or none of it.
    vec2 mUv = vWorld.xz / (2.0 * uUrbanExtent) + 0.5;
    float urban = texture(uUrban, mUv).r;
    urban *= step(0.0, mUv.x) * step(mUv.x, 1.0) * step(0.0, mUv.y) * step(mUv.y, 1.0);

    // Night from the air is DISCRETE LIGHTS with black between them, not a lit
    // surface. Speckled on a ~26 m lattice with only a fraction of cells lit, so
    // the peak reads as a lamp while the average stays near black. Far away the
    // speckle converges to its own mean, or it would alias into crawling noise.
    // Lamps are POINTS inside their cell, not the whole cell.
    //
    // Filling the cell made a lattice of glowing rectangles -- from the air it
    // read as luminous paving rather than street lighting. A soft dot at a
    // jittered position within each chosen cell reads as a light, and the
    // jitter stops the grid itself from being visible.
    const float LAMP_SPACING = 30.0;
    const float LAMP_FRACTION = 0.22;
    // Mean of the dot kernel over a cell, for the far field.
    const float LAMP_MEAN = LAMP_FRACTION * 0.17;

    float detail = smoothstep(4500.0, 900.0, vViewDist);
    vec2 g = vWorld.xz * (1.0 / LAMP_SPACING);
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float pick = hash21(gi);
    float dot_ = 0.0;
    if (pick < LAMP_FRACTION) {
      vec2 jit = vec2(hash21(gi + 11.1), hash21(gi + 27.3));
      float d = length(gf - jit);
      dot_ = exp(-d * d * 18.0);
    }
    float lamps = mix(LAMP_MEAN, dot_, detail);

    lit += vec3(1.0, 0.76, 0.44) * lamps * urban * uNight * 1.15;

    // Skyglow on the built-up ground only, and nearly monochrome: at this light
    // level the eye takes almost no colour off a surface, and carrying the
    // drape's daytime hue through is what made the city look like a dimmed
    // photograph rather than a dark place with lights in it.
    float grey = dot(albedo, vec3(0.299, 0.587, 0.114));
    lit += mix(vec3(grey), albedo, 0.25) * uNightGlow * urban * 0.85;
  }

  // Aerial perspective: the same integral the sky uses, over the distance to
  // this fragment. This is what unifies ground and sky into one atmosphere.
  vec3 ro = atmoOrigin(uCamAltitude);
  vec3 rd = normalize(vWorld - uCameraPos);
  vec3 trans;
  vec3 inscatter = atmosphere(ro, rd, vViewDist, trans);
  vec3 col = lit * trans + inscatter;

  // Term isolation. Chasing a too-bright image by arithmetic is slow and easy
  // to get wrong; showing one term at a time answers it in one look.
  //   1 albedo  2 direct  3 ambient  4 inscatter  5 lit  6 transmittance
  if (uDebug > 0.5) {
    if (uDebug < 1.5)      col = albedo;
    else if (uDebug < 2.5) col = direct;
    else if (uDebug < 3.5) col = ambient;
    else if (uDebug < 4.5) col = inscatter;
    else if (uDebug < 5.5) col = lit;
    else if (uDebug < 6.5) col = trans;
    else if (uDebug < 7.5) col = vec3(water);
    else                   col = vec3(vWorld.y / 200.0);
  }

  fragColor = vec4(col, 1.0);
}
`;

export interface TerrainUniforms extends Record<string, THREE.IUniform> {
  uDrape: THREE.IUniform<THREE.Texture | null>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uWetness: THREE.IUniform<number>;
  uSnow: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uUrban: THREE.IUniform<THREE.Texture | null>;
  uUrbanExtent: THREE.IUniform<number>;
  uExposure: THREE.IUniform<number>;
  uSunSurface: THREE.IUniform<number>;
  uDebug: THREE.IUniform<number>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunIntensity: THREE.IUniform<number>;
  uMieG: THREE.IUniform<number>;
  uTurbidity: THREE.IUniform<number>;
  uCamAltitude: THREE.IUniform<number>;
  uMultiScatter: THREE.IUniform<number>;
}

export function makeTerrainUniforms(): TerrainUniforms {
  return {
    uDrape: { value: null },
    uCameraPos: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Color(0.28, 0.36, 0.5) },
    uWetness: { value: 0 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uUrban: { value: null },
    uUrbanExtent: { value: 1 },
    uExposure: { value: 1 },
    uSunSurface: { value: 0.105 },
    uDebug: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSunIntensity: { value: 22 },
    uMieG: { value: 0.76 },
    uTurbidity: { value: 1 },
    uCamAltitude: { value: 100 },
    uMultiScatter: { value: 0.055 },
  };
}

/**
 * Build one ring. `inner` is the half-width of the hole punched in the middle
 * (0 for the innermost ring), so rings tile without overdrawing each other.
 */
function buildRingGeometry(
  ring: TerrainRing,
  inner: number,
  origin: Origin,
  height: (lat: number, lon: number) => number,
  drapeBbox: { west: number; east: number; south: number; north: number },
): THREE.BufferGeometry {
  const n = ring.segments;
  const step = (ring.extent * 2) / n;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Vertex grid, with a hole where the finer ring will sit.
  const idx = new Int32Array((n + 1) * (n + 1)).fill(-1);
  let count = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = -ring.extent + i * step;
      const z = -ring.extent + j * step;
      // Keep one row of vertices inside the hole edge so the quad that spans
      // the boundary still has corners to reference.
      if (inner > 0 && Math.abs(x) < inner - step && Math.abs(z) < inner - step) continue;
      const ll = origin.toLatLon(x, z);
      const y = height(ll.lat, ll.lon);
      positions.push(x, y, z);
      uvs.push(
        (ll.lon - drapeBbox.west) / (drapeBbox.east - drapeBbox.west),
        (drapeBbox.north - ll.lat) / (drapeBbox.north - drapeBbox.south),
      );
      idx[j * (n + 1) + i] = count++;
    }
  }

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = idx[j * (n + 1) + i];
      const b = idx[j * (n + 1) + i + 1];
      const c = idx[(j + 1) * (n + 1) + i];
      const d = idx[(j + 1) * (n + 1) + i + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Skirt: a curtain hanging from the outer edge, hiding the crack against the
  // next ring out and the gap at the world edge.
  const skirtDrop = 400;
  const edge: number[] = [];
  for (let i = 0; i <= n; i++) edge.push(idx[0 * (n + 1) + i]);
  for (let j = 1; j <= n; j++) edge.push(idx[j * (n + 1) + n]);
  for (let i = n - 1; i >= 0; i--) edge.push(idx[n * (n + 1) + i]);
  for (let j = n - 1; j >= 1; j--) edge.push(idx[j * (n + 1) + 0]);

  const skirtStart = count;
  for (const e of edge) {
    if (e < 0) continue;
    positions.push(positions[e * 3], positions[e * 3 + 1] - skirtDrop, positions[e * 3 + 2]);
    uvs.push(uvs[e * 2], uvs[e * 2 + 1]);
    count++;
  }
  const valid = edge.filter((e) => e >= 0);
  for (let k = 0; k < valid.length - 1; k++) {
    const top0 = valid[k];
    const top1 = valid[k + 1];
    const bot0 = skirtStart + k;
    const bot1 = skirtStart + k + 1;
    indices.push(top0, bot0, top1, top1, bot0, bot1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly uniforms: TerrainUniforms[] = [];

  /** Height above sea level at a world point, from the finest field that has it. */
  heightAt: (x: number, z: number) => number;

  constructor(
    origin: Origin,
    fields: Heightfield[],
    drapes: StitchedImage[],
    rings: TerrainRing[] = CITY_RINGS,
  ) {
    // Finest-first lookup, so a point inside the near field uses the 30 m data
    // and a point out on the horizon falls through to the coarse one.
    const sample = (lat: number, lon: number): number => {
      for (const f of fields) if (f.contains(lat, lon)) return f.sample(lat, lon);
      const last = fields[fields.length - 1];
      return last ? last.sample(lat, lon) : 0;
    };

    this.heightAt = (x, z) => {
      const ll = origin.toLatLon(x, z);
      return sample(ll.lat, ll.lon);
    };

    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const inner = r === 0 ? 0 : rings[r - 1].extent;
      const drape = drapes[Math.min(r, drapes.length - 1)];
      const geo = buildRingGeometry(ring, inner, origin, sample, drape.bbox);

      const tex = new THREE.CanvasTexture(drape.canvas as unknown as HTMLCanvasElement);
      // Decoded in the shader by srgbToLinear(); tagging it sRGB here as well
    // would decode it twice.
    tex.colorSpace = THREE.NoColorSpace;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 16;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;

      const u = makeTerrainUniforms();
      u.uDrape.value = tex;
      this.uniforms.push(u);

      const mat = new THREE.RawShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: u,
        glslVersion: THREE.GLSL3,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = r;
      this.group.add(mesh);
    }
  }
}
