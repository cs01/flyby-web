// Per-pass GPU and CPU time, for tools/profile.ts.
//
// Frame time alone cannot say WHICH pass is slow, and toggling passes off one
// at a time misattributes anything that shares a cost (the cascades and the
// city map both pay the vertex fetch of the same buildings). So this asks the
// GPU directly with EXT_disjoint_timer_query_webgl2, which Chrome on Apple
// Silicon exposes through ANGLE's Metal backend.
//
// Timer queries cannot nest, so labels form a STACK and every time is
// EXCLUSIVE: opening "scene/buildings" inside "scene" ends the running
// "scene" query and starts a new one, and closing it resumes "scene". The
// per-label numbers therefore add up to the frame instead of double counting.
//
// Off unless the page was loaded with `?gpuprof`, and every entry point is an
// early return when it is off, so the app pays one branch per call site.

import type * as THREE from "three";

type GL = WebGL2RenderingContext;

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface Segment {
  q: WebGLQuery;
  label: string;
}

export interface ProfileReport {
  /** Frames whose every query resolved and none was disjoint. */
  frames: number;
  /** Mean GPU ms per frame, by label, exclusive. */
  gpu: Record<string, number>;
  /** Mean CPU ms per frame, by label, inclusive (CPU labels may nest). */
  cpu: Record<string, number>;
  /** The worst single frame's CPU ms, by label: where a hitch came from. */
  cpuMax: Record<string, number>;
  disjoint: number;
}

export class FrameProfiler {
  enabled = false;
  /** Attribute the main pass per object; see `objectLabel` and main.ts. */
  objects = false;

  private gl: GL | null = null;
  private ext: TimerExt | null = null;
  private free: WebGLQuery[] = [];
  private stack: string[] = [];
  private open: Segment | null = null;
  private frame: Segment[] = [];
  private inflight: Segment[][] = [];
  private gpuSum = new Map<string, number>();
  private cpuSum = new Map<string, number>();
  private cpuStart = new Map<string, number>();
  private cpuMax = new Map<string, number>();
  private frames = 0;
  private cpuFrames = 0;
  private disjoint = 0;

  /** Time only the whole frame, as one query: the check on the others. */
  wholeFrame = false;

  init(gl: GL, objects: boolean, wholeFrame = false): boolean {
    this.wholeFrame = wholeFrame;
    const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    this.gl = gl;
    this.ext = ext;
    this.enabled = true;
    this.objects = objects && !!ext;
    return !!ext;
  }

  /** The label on top of the stack, or "" when nothing is open. */
  get current(): string {
    return this.stack.length ? this.stack[this.stack.length - 1] : "";
  }

  begin(label: string): void {
    if (!this.enabled || !this.ext) return;
    if (this.wholeFrame && label !== "frame" && this.stack.length) {
      this.stack.push(this.current);
      return;
    }
    this.stack.push(label);
    this.switchTo(label);
  }

  end(): void {
    if (!this.enabled || !this.ext) return;
    const was = this.stack.pop();
    if (this.wholeFrame && was === this.current) return;
    this.switchTo(this.current);
  }

  cpuBegin(label: string): void {
    if (!this.enabled) return;
    this.cpuStart.set(label, performance.now());
  }

  cpuEnd(label: string): void {
    if (!this.enabled) return;
    const t0 = this.cpuStart.get(label);
    if (t0 === undefined) return;
    const ms = performance.now() - t0;
    this.cpuSum.set(label, (this.cpuSum.get(label) ?? 0) + ms);
    if (ms > (this.cpuMax.get(label) ?? 0)) this.cpuMax.set(label, ms);
  }

  frameEnd(): void {
    if (!this.enabled) return;
    this.cpuFrames++;
    if (!this.ext || !this.gl) return;
    this.switchTo("");
    this.stack.length = 0;
    this.inflight.push(this.frame);
    this.frame = [];
    this.collect();
  }

  reset(): void {
    this.gpuSum.clear();
    this.cpuSum.clear();
    this.cpuMax.clear();
    this.frames = 0;
    this.cpuFrames = 0;
    this.disjoint = 0;
  }

  report(): ProfileReport {
    const gpu: Record<string, number> = {};
    const cpu: Record<string, number> = {};
    for (const [k, v] of this.gpuSum) gpu[k] = v / Math.max(1, this.frames);
    for (const [k, v] of this.cpuSum) cpu[k] = v / Math.max(1, this.cpuFrames);
    const cpuMax: Record<string, number> = {};
    for (const [k, v] of this.cpuMax) cpuMax[k] = v;
    return { frames: this.frames, gpu, cpu, cpuMax, disjoint: this.disjoint };
  }

  private switchTo(label: string): void {
    const gl = this.gl!;
    if (this.open) {
      gl.endQuery(this.ext!.TIME_ELAPSED_EXT);
      this.frame.push(this.open);
      this.open = null;
    }
    if (!label) return;
    const q = this.free.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext!.TIME_ELAPSED_EXT, q);
    this.open = { q, label };
  }

  private collect(): void {
    const gl = this.gl!;
    while (this.inflight.length) {
      const segs = this.inflight[0];
      const last = segs[segs.length - 1];
      if (last && !gl.getQueryParameter(last.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inflight.shift();
      const disjoint = gl.getParameter(this.ext!.GPU_DISJOINT_EXT) as boolean;
      if (disjoint) this.disjoint++;
      for (const s of segs) {
        if (!disjoint) {
          const ns = gl.getQueryParameter(s.q, gl.QUERY_RESULT) as number;
          this.gpuSum.set(s.label, (this.gpuSum.get(s.label) ?? 0) + ns / 1e6);
        }
        this.free.push(s.q);
      }
      if (!disjoint) this.frames++;
    }
  }
}

export const prof = new FrameProfiler();

/**
 * The bucket a drawable is charged to in the main pass: the top-level group it
 * hangs under, plus the material for the buildings, whose shaders differ by
 * an order of magnitude in cost (glass with interiors against a flat roof).
 */
function objectLabel(o: THREE.Object3D): string {
  let top = o;
  while (top.parent && top.parent.type !== "Scene") top = top.parent;
  const name = top.name || top.type;
  return `scene/${name}`;
}

const HOOKED = Symbol("gpuprof");

/** Wrap every drawable's render callbacks. Idempotent, so streamed tiles can
 *  be picked up by calling it again. */
export function installObjectProfiling(scene: THREE.Scene): void {
  scene.traverse((o) => {
    const r = o as THREE.Object3D & { [HOOKED]?: boolean; isMesh?: boolean; isPoints?: boolean; isLine?: boolean };
    if (r[HOOKED] || !(r.isMesh || r.isPoints || r.isLine)) return;
    r[HOOKED] = true;
    const label = objectLabel(o);
    const before = o.onBeforeRender;
    const after = o.onAfterRender;
    let opened = false;
    o.onBeforeRender = function (...args) {
      // Only inside the main pass: the same objects are drawn by the cascades,
      // the AO prepass and the probes, which have their own labels.
      opened = prof.current.startsWith("scene");
      if (opened) prof.begin(label);
      before.apply(this, args);
    };
    o.onAfterRender = function (...args) {
      after.apply(this, args);
      if (opened) prof.end();
      opened = false;
    };
  });
}
