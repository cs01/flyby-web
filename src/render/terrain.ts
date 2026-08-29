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
import { SUN_SHADOW_GLSL, SHADOW_CASTER_LAYER, type SunShadowUniforms } from "./sunshadow";

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
  // The ring the aircraft actually flies through. At zoom 15 a street is
  // ~3.6 m per pixel, which is a smear; zoom 16 halves that and road markings,
  // car parks and pitch lines resolve. It is only 2.2 km across, so the extra
  // sharpness costs about a hundred tiles rather than thousands.
  { extent: 2200, segments: 224, imageryZoom: 16 },
  { extent: 6000, segments: 320, imageryZoom: 15 },
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
${SUN_SHADOW_GLSL}

uniform sampler2D uDrape;
uniform vec3  uCameraPos;
uniform vec3  uAmbient;
uniform float uWetness;
uniform float uSnow;
uniform float uNight;
uniform float uSunSurface;
uniform float uDebug;
uniform vec3 uNightGlow;
uniform vec3 uMoonDir;
// Moon colour * intensity, in the same units as uSunColor * uSunIntensity, so
// it converts to surface irradiance through the same uSunSurface.
uniform vec3 uMoonLight;
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
  // Cascaded shadow map, on the DIRECT beam only. The ambient sky term below is
  // deliberately untouched: ground in the shadow of a tower is still under the
  // whole sky dome, and zeroing that is what turns a shadow into a black hole.
  float sunVis = sunVisibility(vWorld, n, uSunDir, vViewDist);
  vec3 direct = uSunColor * uSunIntensity * uSunSurface * sunT * ndl * sunVis;

  // Moonlight. The one thing that makes a night flight over open country
  // something other than a black frame: the street-lamp mask only covers
  // built-up ground, so without this a coastline, a river or a ridge line
  // outside the city simply is not there.
  float mndl = max(0.0, dot(n, uMoonDir));
  vec3 moonBeam = uMoonLight * uSunSurface * mndl;
  vec3 beam = direct + moonBeam;

  // Sky ambient, weighted by how much sky the surface can see. A valley floor
  // is darker than a ridge for the same sun angle, which is most of what makes
  // terrain read as three-dimensional at low sun.
  vec3 ambient = uAmbient * (0.55 + 0.45 * n.y);

  vec3 lit = albedo * (beam + ambient);

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
  // Water: elevation FIRST, appearance as a backstop.
  //
  // Elevation alone is not enough. The DEM carries small positive values in
  // patches out on open water, and where that lifted a patch above the
  // threshold it was shaded as LAND -- using the drape's near-black water
  // pixels, which lights to roughly a tenth of the Fresnel water all around it.
  // The result was dark angular holes lying in the middle of the Hudson.
  //
  // So a second test runs alongside: ground that is BOTH low and dark in the
  // imagery is water too. Neither test alone is reliable (open water is not
  // always exactly zero, and dark low ground is sometimes a car park), but a
  // patch has to fail both to be mistaken for land.
  float lumA = dot(albedo, vec3(0.299, 0.587, 0.114));
  float byElevation = smoothstep(3.5, 0.4, vWorld.y);
  float byAppearance = smoothstep(0.26, 0.07, lumA) * smoothstep(7.0, 1.0, vWorld.y);
  float water = clamp(max(byElevation, byAppearance), 0.0, 1.0);
  float gloss = max(uWetness, water);
  vec3 v = normalize(uCameraPos - vWorld);
  if (gloss > 0.01) {
    float shine = mix(48.0, 320.0, water);
    vec3 hv = normalize(v + uSunDir);
    float spec = pow(max(0.0, dot(n, hv)), shine);
    lit += uSunColor * uSunIntensity * uSunSurface * sunT * spec * gloss * 1.6 * sunVis;
    // The moon's own glitter path. Water at night is otherwise the darkest
    // thing in the frame, and the moonglade is the only thing that says which
    // part of that darkness is sea.
    vec3 hm = normalize(v + uMoonDir);
    float specM = pow(max(0.0, dot(n, hm)), shine);
    lit += uMoonLight * uSunSurface * specM * gloss * 1.6;
  }

  // Open water is not a dark diffuse surface. Its colour is almost entirely
  // FRESNEL: looking straight down it is nearly black (you see the 0.02
  // reflectance and a little subsurface blue-green), and at a grazing angle it
  // becomes a mirror of the sky. That angular swing is what makes water read as
  // water, and no amount of tinting a diffuse albedo reproduces it.
  if (water > 0.01) {
    float f = pow(1.0 - clamp(dot(v, n), 0.0, 1.0), 5.0);
    float fres = 0.02 + 0.98 * f;
    vec3 deep = vec3(0.004, 0.016, 0.030) * (beam + ambient);
    vec3 skyRefl = uAmbient * 1.7
                 + uSunColor * uSunIntensity * uSunSurface * sunT * 0.10
                 + uMoonLight * uSunSurface * 0.10;
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
    // How tight the dot is. exp(-k d^2) integrates to pi/k over the cell for
    // any k this large, which is what keeps the far-field mean honest below.
    //
    // It used to be 18, and 18 is a blob 12 m across: from the air the city
    // read as a field of soft orange smudges rather than as lights. A lamp is
    // a POINT with a hot core -- the peak is deliberately over 1.0 so the tone
    // curve clips it to white, because that is what a light source does and it
    // is the difference between a lamp and a glowing patch of ground.
    const float LAMP_SHARP = 55.0;
    const float LAMP_PEAK = 3.05;   // energy-matched to the old soft kernel
    const float LAMP_MEAN = LAMP_FRACTION * LAMP_PEAK * (3.14159265 / LAMP_SHARP);

    float detail = smoothstep(4500.0, 900.0, vViewDist);
    vec2 g = vWorld.xz * (1.0 / LAMP_SPACING);
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float pick = hash21(gi);
    float dot_ = 0.0;
    // Sodium against mercury and LED. A city is not one colour of light, and
    // a field of identically warm dots is most of what made this look
    // synthetic. Skewed warm, because most street lighting still is.
    vec3 tint = vec3(1.0, 0.78, 0.50);
    if (pick < LAMP_FRACTION) {
      vec2 jit = vec2(hash21(gi + 11.1), hash21(gi + 27.3));
      float d = length(gf - jit);
      // Per-lamp brightness, mean 1.0 so the far-field average is unchanged.
      float bright = 0.55 + 0.9 * hash21(gi + 41.7);
      dot_ = LAMP_PEAK * bright * exp(-d * d * LAMP_SHARP);
      float warmth = hash21(gi + 63.1);
      tint = mix(vec3(0.80, 0.88, 1.0), vec3(1.0, 0.70, 0.32),
                 smoothstep(0.05, 0.55, warmth));
    }
    float lamps = mix(LAMP_MEAN, dot_, detail);
    // Far away the individual tints have averaged out too, so the mean colour
    // is what the far field must use.
    vec3 lampColour = mix(vec3(1.0, 0.78, 0.50), tint, detail);

    lit += lampColour * lamps * urban * uNight * 1.15;

    // Skyglow on the built-up ground only, and nearly monochrome: at this light
    // level the eye takes almost no colour off a surface, and carrying the
    // drape's daytime hue through is what made the city look like a dimmed
    // photograph rather than a dark place with lights in it.
    float grey = dot(albedo, vec3(0.299, 0.587, 0.114));
    // FLATTENED, not just desaturated. Carrying the drape's daytime contrast
    // through at night is what made the ground read as a dimmed photograph
    // with lights sprinkled on it: every road, roof and car park still legible
    // at midnight. A dark-adapted eye takes almost no texture off a surface
    // either, so the luminance is compressed most of the way to a constant and
    // only a trace of the drape's own shape survives.
    grey = mix(0.30, grey, 0.40);
    lit += mix(vec3(grey), albedo, 0.12) * uNightGlow * urban * 0.85;
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
    else if (uDebug < 2.5) col = beam;
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

export interface TerrainUniforms extends SunShadowUniforms {
  uDrape: THREE.IUniform<THREE.Texture | null>;
  uCameraPos: THREE.IUniform<THREE.Vector3>;
  uAmbient: THREE.IUniform<THREE.Color>;
  uWetness: THREE.IUniform<number>;
  uSnow: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  uNightGlow: THREE.IUniform<THREE.Color>;
  uMoonDir: THREE.IUniform<THREE.Vector3>;
  uMoonLight: THREE.IUniform<THREE.Color>;
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

/**
 * `shadow` is spread in by REFERENCE: every ring shares the one set of cascade
 * uniforms the SunShadow pass writes, so a ring cannot fall a frame behind.
 */
export function makeTerrainUniforms(shadow: SunShadowUniforms): TerrainUniforms {
  return {
    ...shadow,
    uDrape: { value: null },
    uCameraPos: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Color(0.28, 0.36, 0.5) },
    uWetness: { value: 0 },
    uSnow: { value: 0 },
    uNight: { value: 0 },
    uNightGlow: { value: new THREE.Color(0, 0, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonLight: { value: new THREE.Color(0, 0, 0) },
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
    shadow: SunShadowUniforms,
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

      const u = makeTerrainUniforms(shadow);
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
      // Only the rings that a cascade can actually reach cast. The outer two
      // span 20 and 70 km and are never frustum-culled, so putting them in the
      // shadow pass would redraw 200k triangles three times a frame to occlude
      // ground that is already past the last cascade.
      if (ring.extent <= 6000) mesh.layers.enable(SHADOW_CASTER_LAYER);
      this.group.add(mesh);
    }
  }
}
