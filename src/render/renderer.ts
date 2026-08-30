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
import type { Budget } from "./budget";

export interface RendererBundle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createRenderer(canvas: HTMLCanvasElement, budget: Budget): RendererBundle {
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

  // Capped, and capped in render/budget.ts rather than here, because the
  // drawing buffer this produces is the largest single term in the memory
  // estimate the budget reports.
  renderer.setPixelRatio(budget.device.pixelRatio);
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
  // horizon ring and distant mountains are inside the frustum.
  //
  // There is NO logarithmic depth buffer, whatever this comment used to claim.
  // three.js only injects one into materials it builds itself and every
  // material here is a RawShaderMaterial, so `logarithmicDepthBuffer` would be
  // ignored even if it were set. The frustum ratio is absorbed instead by the
  // fact that the NEAR plane, not the far one, sets the quantisation: a 24-bit
  // fixed-point depth is good to z^2 * 3.0e-8 metres, which is sub-millimetre
  // at 100 m and metres at 10 km. Anything that reconstructs position from this
  // buffer has to fade out with distance rather than trust the far end of it;
  // see render/ao.ts.
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
export function createSceneTarget(renderer: THREE.WebGLRenderer, budget: Budget): THREE.WebGLRenderTarget {
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
  // resolve, and going to 8 is not visible on this content. Whether this device
  // gets it is render/budget.ts's call, alongside every other thing the tier
  // decides, and the multisampled buffers it adds are itemised in the estimate
  // that panel prints.
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: depth,
    samples: budget.msaaSamples,
  });
  return rt;
}
