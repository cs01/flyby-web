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
  });

  // Cap at 2x. Beyond that the cost is quadratic and the gain is invisible.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
