// One environment probe for the whole scene: the sky, captured and turned into
// light every surface can read.
//
// Why one probe and not one per object. The sky is at infinity and it is the
// thing that changes, so a probe taken anywhere near the camera is the same
// probe every building in the frame wants. A per-building probe would be
// thousands of cube renders for six identical answers.
//
// It produces two things from the same capture:
//
//   * Diffuse irradiance as 9 SH coefficients. This is what replaces the
//     `uAmbient * (0.55 + 0.45 * n.y)` hemispherical constant that every
//     surface shader used to run. That constant has no azimuth in it at all, so
//     at sunset a wall facing the orange western sky and a wall facing the dark
//     eastern one were lit identically, which is most of what made the city
//     read as painted rather than as lit.
//   * A prefiltered cube for specular, roughness mapped to mip level. Glass
//     curtain walls and wet asphalt are mirrors, and a mirror with nothing in
//     it is what makes a glass tower read as grey plastic.
//
// It captures the SAME atmosphere the sky dome draws, by including
// atmosphere.glsl.ts rather than approximating it. A probe built from a
// different sky model gives every shaded surface a colour that disagrees with
// the background, and the disagreement is more visible than either sky is
// wrong on its own.
//
// Two deliberate omissions:
//
//   * No sun disc. The direct beam is already the `direct` term in every
//     surface shader, so a probe containing the disc would light everything
//     twice. What the probe carries is the sky AROUND the sun.
//   * No city geometry. Six renders of the skyline per refresh would be
//     affordable (geometry is not the scarce resource here) but the buildings
//     read the probe's own output, so a probe containing them is a feedback
//     loop that needs a frame of history and an energy cap to stay stable. The
//     ground is a plane instead: see the ground term in the shader.

import * as THREE from "three";
import { ATMOSPHERE_GLSL } from "./atmosphere.glsl";
import {
  CUBE_FACES,
  CUBE_FACE_BASIS,
  SH9,
  shHemispherical,
  shNormaliseAt,
  shProjectCubeFaces,
  shZero,
} from "./sh";
import type { SceneLighting } from "./lighting";

/**
 * Conversion from the atmosphere integral's units to surface irradiance. It has
 * to be the value the surface shaders use for their direct beam (`uSunSurface`,
 * 0.105) or the ground plane in the probe sits at a different exposure from the
 * terrain it stands in for.
 */
const SUN_SURFACE = 0.105;

/** Face resolution for the SH capture. L2 irradiance needs almost nothing. */
const SH_FACE = 16;

const VERT = /* glsl */ `
out vec2 vNdc;
void main() {
  // Fullscreen triangle from gl_VertexID; no attributes, same trick as sky.ts.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vNdc = p;
  gl_Position = vec4(p, 1.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vNdc;
out vec4 fragColor;

// The probe is six small renders on a slow cadence, so it can afford the full
// march the sky dome uses rather than the shortened one the surface shaders
// run per fragment.
${ATMOSPHERE_GLSL}

// Maps face coordinates to a world direction. Handed in from sh.ts so the
// capture and the CPU-side SH projection cannot disagree about which texel
// looks where.
uniform mat3  uFaceBasis;
uniform vec3  uGroundAlbedo;
uniform vec3  uGroundAmbient;

void main() {
  vec3 rd = normalize(uFaceBasis * vec3(vNdc, 1.0));
  vec3 ro = atmoOrigin(uCamAltitude);

  vec3 trans;
  vec3 col = atmosphere(ro, rd, 1.0e7, trans);

  // A ground plane under the horizon, shaded the way terrain.ts shades it:
  // albedo times (direct beam plus sky ambient), through the same transmittance
  // the view ray accumulates on its way down.
  //
  // Crude, and it earns its place anyway. Sunlit ground is BRIGHTER than blue
  // sky, so for a vertical wall the bounce off the street is a larger part of
  // the ambient than the sky is. Leaving the lower hemisphere as haze is
  // exactly the "shaded faces go black" defect this probe exists to fix.
  //
  // atmosphere() already stopped the march at the ground for a downward ray,
  // so trans is the transmittance of the whole path to it and the aerial
  // perspective on the ground is the same as the terrain's own.
  if (rd.y < 0.0) {
    vec3 groundSunT = sunTransmittance(atmoOrigin(0.0), uSunDir, uTurbidity);
    vec3 lit = uGroundAlbedo *
      (uSunColor * uSunIntensity * ${SUN_SURFACE.toFixed(4)} * groundSunT * max(0.0, uSunDir.y)
       + uGroundAmbient);
    // Faded in over the first couple of degrees below the horizon. A hard edge
    // here would show up as a hard line in every glass reflection in the city.
    col += lit * trans * smoothstep(0.0, -0.035, rd.y);
  }

  fragColor = vec4(col, 1.0);
}
`;

/** How often the probe re-renders, and why those numbers. */
// The sky changes when the sun moves or the air changes, and both are slow: a
// quarter of a degree of solar motion is a minute of real time. What is NOT
// slow is the time scrubber, which can run a whole day past in a few seconds,
// so the cadence is driven by how much the lighting actually moved rather than
// by a fixed frame count alone.
const MIN_FRAMES = 6;
const MAX_FRAMES = 45;
/** Refresh once the sun has moved this far, in radians. */
const SUN_MOVE = 0.009;

const SNOW_ALBEDO = new THREE.Color(0.72, 0.75, 0.8);

export class SkyProbe {
  /** Prefiltered radiance for specular. Sample with `textureLod`. */
  readonly texture: THREE.CubeTexture;
  /**
   * Diffuse irradiance, 9 RGB coefficients. Shared BY REFERENCE into every
   * surface material's `uSH` uniform, so a refresh reaches all of them without
   * anything having to remember to copy it.
   */
  readonly sh: SH9 = shZero();

  private cube: THREE.WebGLCubeRenderTarget;
  private strip: THREE.WebGLRenderTarget;
  private pixels = new Float32Array(SH_FACE * SH_FACE * CUBE_FACES * 4);
  private raw = shZero();
  /** True while a readback is in flight; a second one would fight it. */
  private reading = false;
  /** The scene ambient as it was when the pixels now in flight were drawn. */
  private ambient = new Float32Array(3);

  private material: THREE.RawShaderMaterial;
  private uniforms: Record<string, THREE.IUniform>;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private basis: THREE.Matrix3[] = [];

  private frames = MAX_FRAMES;
  private lastSun = new THREE.Vector3(0, -1, 0);
  private lastAlt = -1;
  private lastTurbidity = -1;
  private rendered = false;

  constructor(size = 64) {
    this.cube = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.texture = this.cube.texture;

    // Float rather than half: this one is read back to the CPU, and a float
    // target reads straight into a Float32Array with no 16-bit decode step.
    this.strip = new THREE.WebGLRenderTarget(SH_FACE, SH_FACE * CUBE_FACES, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });

    for (const m of CUBE_FACE_BASIS) {
      // Matrix3.set is row major, and the basis rows are the three column
      // vectors, so this transposes on the way in.
      this.basis.push(
        new THREE.Matrix3().set(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]),
      );
    }

    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunIntensity: { value: 22 },
      uMieG: { value: 0.76 },
      uTurbidity: { value: 1 },
      uCamAltitude: { value: 100 },
      uMultiScatter: { value: 0.055 },
      uFaceBasis: { value: new THREE.Matrix3() },
      uGroundAlbedo: { value: new THREE.Color(0.16, 0.155, 0.145) },
      uGroundAmbient: { value: new THREE.Color(0.2, 0.24, 0.3) },
    };

    this.material = new THREE.RawShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      glslVersion: THREE.GLSL3,
      depthWrite: false,
      depthTest: false,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    // Something safe to shade with before the first capture: exactly the
    // hemispherical ambient the shaders ran before this class existed.
    this.sh.set(shHemispherical([0.28, 0.36, 0.5], 0.55, 0.45));
  }

  /** Roughness maps onto [0, maxLod]. */
  get maxLod(): number {
    return Math.log2(this.cube.width);
  }

  setSize(size: number): void {
    if (size !== this.cube.width) {
      this.cube.setSize(size, size);
      this.rendered = false;
    }
  }

  /**
   * Re-render the probe if the lighting has moved enough to be worth it.
   *
   * Must run before the main scene pass, and before anything reads `sh` or
   * `texture` for the first time: the very first call always captures, so no
   * shader ever samples an uninitialised cube.
   *
   * Returns true when it actually captured.
   */
  update(renderer: THREE.WebGLRenderer, light: SceneLighting, camAltitude: number): boolean {
    const u = this.uniforms;
    this.frames++;

    const moved =
      !this.rendered ||
      this.lastSun.dot(light.sunDir) < Math.cos(SUN_MOVE) ||
      Math.abs(camAltitude - this.lastAlt) > 60 + 0.12 * Math.abs(this.lastAlt) ||
      Math.abs(light.turbidity - this.lastTurbidity) > 0.04 * this.lastTurbidity;
    if (!(this.frames >= MAX_FRAMES || (moved && this.frames >= MIN_FRAMES))) return false;
    this.frames = 0;

    (u.uSunDir.value as THREE.Vector3).copy(light.sunDir);
    (u.uSunColor.value as THREE.Color).copy(light.sunColor);
    u.uSunIntensity.value = light.sunIntensity;
    u.uMieG.value = light.mieG;
    u.uTurbidity.value = light.turbidity;
    u.uCamAltitude.value = camAltitude;
    (u.uGroundAmbient.value as THREE.Color).copy(light.ambient);
    // Lying snow turns the ground into the brightest surface in the scene and
    // it bounces accordingly; a snowy city with a dark ground bounce is why
    // shaded walls read as slate in the winter.
    (u.uGroundAlbedo.value as THREE.Color)
      .setRGB(0.16, 0.155, 0.145)
      .lerp(SNOW_ALBEDO, light.snow);

    this.lastSun.copy(light.sunDir);
    this.lastAlt = camAltitude;
    this.lastTurbidity = light.turbidity;

    const prevTarget = renderer.getRenderTarget();
    const faceBasis = u.uFaceBasis.value as THREE.Matrix3;

    // The specular cube. three.js regenerates the mip chain at the end of every
    // render into a target, so the six faces come back already filtered; the
    // pyramid is a box filter standing in for a GGX convolution, which is the
    // same trade aircraftmodel.ts makes and for the same reason: at 64 pixels a
    // face nobody can tell the two apart in a reflection.
    for (let f = 0; f < CUBE_FACES; f++) {
      faceBasis.copy(this.basis[f]);
      renderer.setRenderTarget(this.cube, f);
      renderer.render(this.scene, this.camera);
    }

    // The SH capture, six 16-pixel tiles stacked into one target so the whole
    // thing comes back in a single read.
    //
    // The viewport is set on the TARGET rather than through renderer.setViewport
    // because the renderer's own viewport is multiplied by the device pixel
    // ratio, which on a retina display would silently draw each face into a
    // 32-pixel rectangle of a 16-pixel tile.
    this.strip.scissorTest = true;
    for (let f = 0; f < CUBE_FACES; f++) {
      faceBasis.copy(this.basis[f]);
      this.strip.viewport.set(0, f * SH_FACE, SH_FACE, SH_FACE);
      this.strip.scissor.set(0, f * SH_FACE, SH_FACE, SH_FACE);
      renderer.setRenderTarget(this.strip);
      renderer.render(this.scene, this.camera);
    }
    this.strip.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    this.rendered = true;

    // A readback, which is the one genuinely awkward thing in this file and the
    // reason the cadence above exists.
    //
    // Measured on the fixed poses. Reading 24 kB back costs nothing; what costs
    // is that a GPU-to-CPU read cannot start until everything already queued
    // has finished, so it blocks the calling frame for however deep the driver
    // queue happens to be. Uncapped, this renderer runs the GPU about twenty
    // frames ahead and the read blocks for ~100 ms. At 60 Hz the queue is one
    // frame and it costs nothing measurable: the whole 600-frame sample stayed
    // between 16.7 and 18.8 ms, with no frame dropped.
    //
    // The async form is used anyway, because it moves the fence wait off the
    // main thread and leaves only the flush. It also means the coefficients are
    // a frame or two old, which at this cadence is not a quantity anything can
    // notice.
    if (!this.reading) {
      this.reading = true;
      this.ambient[0] = light.ambient.r;
      this.ambient[1] = light.ambient.g;
      this.ambient[2] = light.ambient.b;
      renderer
        .readRenderTargetPixelsAsync(this.strip, 0, 0, SH_FACE, SH_FACE * CUBE_FACES, this.pixels)
        .then(() => this.project())
        // A failed read leaves the previous coefficients in place, which is the
        // last good sky rather than a black one.
        .catch(() => undefined)
        .finally(() => {
          this.reading = false;
        });
    }
    return true;
  }

  private project(): void {
    shProjectCubeFaces(this.pixels, SH_FACE, this.raw);
    // The probe supplies shape, the scene's lighting model supplies level: see
    // shNormaliseAt. When it cannot (a night sky has no shape worth having, and
    // dividing by it would amplify nothing into everything) the hemispherical
    // fallback stands in, which is what the shaders did before the probe.
    if (shNormaliseAt(this.raw, 0, 1, 0, this.ambient, 1e-5)) {
      this.sh.set(this.raw);
    } else {
      this.sh.set(shHemispherical(this.ambient, 0.55, 0.45));
    }
  }

  dispose(): void {
    this.cube.dispose();
    this.strip.dispose();
    this.material.dispose();
  }
}
