// WebGL2 setup, exposure and the tone curve.
//
// The renderer works in LINEAR radiance throughout and tone-maps once at the
// end. This is not ceremony: the atmosphere shader produces values well over 1
// looking at the sun and well under 0.01 at civil twilight, and any pipeline
// that clamps to [0,1] before the tone curve turns both into flat white and
// flat black. Keeping it linear is what buys a sunset that still has colour in
// the bright part and a night that still has shape in the dark part.
//
// ACES filmic, applied by three.js. AgX would be the modern choice but it
// desaturates sunsets hard, and sunsets are most of what this app is for.

import * as THREE from "three";

export interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createRenderer(canvas: HTMLCanvasElement): RendererBundle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
    stencil: false,
    // The sky always covers every pixel, so there is nothing to see through to.
    alpha: false,
    // Only under `?shot`, where tools/shots.ts reads the frame back with
    // canvas.toDataURL(). Without it the drawing buffer is thrown away as soon
    // as the frame is composited and the read comes back transparent black. It
    // costs a copy per frame, so it stays off for anyone actually flying.
    preserveDrawingBuffer: new URLSearchParams(location.search).has("shot"),
  });

  // Cap at 1.5x. This renderer is fragment-bound -- a full-screen atmosphere on
  // every surface plus a cloud march -- so pixel count is very nearly the whole
  // cost, and 2x on a Retina panel is 5.7 megapixels of it. The visible gain
  // from 1.5 to 2 is small; the cost is 78% more pixels.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  // Every material in this renderer is a RawShaderMaterial, which three.js does
  // NOT inject tone mapping or colour-space conversion into. The shaders call
  // present() from tonemap.glsl themselves. Setting toneMapping here would have
  // no effect and would only mislead the next reader into thinking it does.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  // Near at 2 m so the aircraft nose does not clip; far at 200 km so the
  // horizon ring and distant mountains are inside the frustum. The ratio is
  // large but a logarithmic depth buffer absorbs it.
  const camera = new THREE.PerspectiveCamera(62, 1, 2, 200000);

  const resize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener("resize", resize);

  return { renderer, scene, camera };
}

/**
 * Offscreen target the scene renders into before the composite pass.
 *
 * Half-float colour because the shaders write LINEAR HDR -- the sky looking at
 * the sun is well over 1.0 and an 8-bit target would clip it to white before
 * the tone curve ever saw it, which defeats the entire point of tone mapping.
 *
 * The depth texture is what lets clouds be composited against the world instead
 * of painted behind it: without a scene distance to march against, an aircraft
 * can never fly INTO a cloud.
 */
export function createSceneTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const depth = new THREE.DepthTexture(size.x, size.y);
  depth.type = THREE.UnsignedIntType;
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;

  // MSAA has to be asked for HERE, not on the renderer.
  //
  // `antialias: true` on WebGLRenderer only ever applies to the DEFAULT
  // framebuffer. Every frame in this app is rendered into this offscreen target
  // and then composited, so that flag has been doing nothing since the
  // composite pass existed, and every edge in the scene was aliased: hard
  // stair-stepped roof lines against the sky, crawling on the window grid, and
  // the drape shimmering at the horizon. On a scene made almost entirely of
  // hard vertical and horizontal building edges, that is most of what read as
  // dated.
  //
  // 4x is the sweet spot: WebGL2 guarantees at least 4, it costs one extra
  // resolve, and going to 8 is not visible on this content. A coarse-pointer
  // device gets 0, because the multisampled colour buffer is 4x the memory of
  // the target and phones are already the constrained case (see the drape plan
  // in terrain.ts, which exists for the same reason).
  const coarse =
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: depth,
    samples: coarse ? 0 : 4,
  });
  return rt;
}
