// The opening shot: a high sweep round the town, then one unbroken descent
// that ends exactly at the walker's eye, so the first frame under the
// player's control is the last frame of the intro.
//
// Pure maths over THREE's vector types, no DOM and no scene, so the
// continuity check (test/intro.check.ts) runs it under bun without a browser.
//
// Position is a centripetal Catmull-Rom spline through a handful of
// keyframes. It is walked by arc length, not by spline parameter, because the
// parameter's speed jumps at every keyframe and that reads as a lurch. The
// speed along the path is proportional to height above the ground: fast over
// the town, slow near the street, which is how a camera operator flies a
// descent and is also what keeps the angular rate of the ground in frame
// roughly constant.
//
// Orientation looks at a target that slides from a point over the town to a
// point level with the eye straight ahead, so the final frame is the walker's
// own view and no snap is needed when control is handed over.

import * as THREE from "three";

export interface IntroSpec {
  /** The walker's eye, world metres. */
  eye: THREE.Vector3;
  /** Compass heading the walker faces, degrees. */
  headingDeg: number;
  /** Ground height under the eye. */
  groundY: number;
  /** Highest thing under a point (ground or roof), to keep keyframes clear. */
  clearAt?: (x: number, z: number) => number;
  /** Seconds for the whole move. */
  durationS?: number;
}

export const INTRO_DURATION_S = 12;
/** How long a skip takes to finish the move. A cut would be quicker and is
 *  the thing the owner asked not to see. */
export const INTRO_SKIP_S = 0.6;

const SAMPLES = 2048;

export class IntroPath {
  readonly duration: number;
  readonly length: number;
  private readonly pts: THREE.Vector3[];
  private readonly knots: number[];
  /** Arc length at each of SAMPLES+1 evenly spaced spline parameters. */
  private readonly arc = new Float64Array(SAMPLES + 1);
  /** Time at each sample, so time -> arc length is a table lookup. */
  private readonly time = new Float64Array(SAMPLES + 1);
  private readonly lookFrom = new THREE.Vector3();
  private readonly lookTo = new THREE.Vector3();
  private readonly ground: number;
  private readonly m = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private readonly tgt = new THREE.Vector3();

  constructor(spec: IntroSpec) {
    this.duration = spec.durationS ?? INTRO_DURATION_S;
    const h = (spec.headingDeg * Math.PI) / 180;
    // Facing on the ground plane: north is -z.
    const fx = Math.sin(h), fz = -Math.cos(h);
    const e = spec.eye;
    const g = spec.groundY;
    this.ground = g;
    // The orbit is centred a little ahead of the spawn, on what the walker
    // will be looking at, and ends behind them looking the same way.
    const cx = e.x + fx * 150, cz = e.z + fz * 150;
    const key = (bearingOffDeg: number, r: number, up: number): THREE.Vector3 => {
      const b = h + Math.PI + (bearingOffDeg * Math.PI) / 180;
      const x = cx + Math.sin(b) * r, z = cz - Math.cos(b) * r;
      const floor = spec.clearAt ? spec.clearAt(x, z) + 60 : -Infinity;
      return new THREE.Vector3(x, Math.max(g + up, floor), z);
    };
    // The approach comes down behind the walker and steepens at the end, so
    // the last stretch is a short drop onto the pavement rather than a long
    // glide through whatever stands behind the spawn.
    const behind = (d: number, up: number) => new THREE.Vector3(e.x - fx * d, e.y + up, e.z - fz * d);
    this.pts = [
      key(-120, 1400, 760),
      key(-80, 1300, 700),
      key(-35, 1050, 540),
      behind(320, 210),
      behind(40, 22),
      e.clone(),
    ];
    // Catmull-Rom needs a point either side of the ends; mirror the
    // neighbours so the curve starts and ends heading along its chords.
    const first = this.pts[0].clone().multiplyScalar(2).sub(this.pts[1]);
    const last = this.pts[this.pts.length - 1].clone().multiplyScalar(2).sub(this.pts[this.pts.length - 2]);
    this.pts.unshift(first);
    this.pts.push(last);
    // Centripetal knots (alpha 0.5): no cusps or self-loops between unevenly
    // spaced keyframes, which the uniform form makes at the short last hop.
    this.knots = [0];
    for (let i = 1; i < this.pts.length; i++) {
      this.knots.push(this.knots[i - 1] + Math.max(1e-3, Math.sqrt(this.pts[i].distanceTo(this.pts[i - 1]))));
    }

    this.lookFrom.set(cx, g + 300, cz);
    this.lookTo.set(e.x + fx * 400, e.y, e.z + fz * 400);

    // Arc length table.
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    this.point(0, q);
    for (let i = 1; i <= SAMPLES; i++) {
      this.point(i / SAMPLES, p);
      this.arc[i] = this.arc[i - 1] + p.distanceTo(q);
      q.copy(p);
    }
    this.length = this.arc[SAMPLES];

    // Time table from the speed profile, then scaled to the duration.
    // v = k * (height + 8) * ramp-in * ramp-out. The square-root ramps give a
    // finite time to start and stop while still reaching zero speed at the
    // eye, so the hand-over has no velocity jump to feel.
    const L = this.length;
    const speed = (d: number, hgt: number) =>
      Math.pow(Math.max(0, hgt) + 20, 0.5) * Math.min(1, Math.sqrt((d + 2) / 80)) * Math.min(1, Math.sqrt((L - d + 0.05) / 60));
    for (let i = 1; i <= SAMPLES; i++) {
      this.point((i - 0.5) / SAMPLES, p);
      const dd = this.arc[i] - this.arc[i - 1];
      this.time[i] = this.time[i - 1] + dd / speed((this.arc[i] + this.arc[i - 1]) / 2, p.y - g);
    }
    const k = this.time[SAMPLES] / this.duration;
    for (let i = 0; i <= SAMPLES; i++) this.time[i] /= k;
  }

  /** Spline position at u in [0, 1] across the real keyframes. */
  private point(u: number, out: THREE.Vector3): THREE.Vector3 {
    const segs = this.pts.length - 3;
    const f = Math.min(segs - 1e-9, Math.max(0, u * segs));
    const i = Math.floor(f) + 1;
    const [p0, p1, p2, p3] = [this.pts[i - 1], this.pts[i], this.pts[i + 1], this.pts[i + 2]];
    const [t0, t1, t2, t3] = [this.knots[i - 1], this.knots[i], this.knots[i + 1], this.knots[i + 2]];
    const t = t1 + (f - (i - 1)) * (t2 - t1);
    // Barry-Goldman pyramid.
    const lerp = (a: THREE.Vector3, b: THREE.Vector3, ta: number, tb: number) =>
      a.clone().multiplyScalar((tb - t) / (tb - ta)).add(b.clone().multiplyScalar((t - ta) / (tb - ta)));
    const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
    const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
    return out.copy(lerp(b1, b2, t1, t2));
  }

  /** Arc length reached at time `t`. */
  distanceAt(t: number): number {
    if (t <= 0) return 0;
    if (t >= this.duration) return this.length;
    let lo = 0, hi = SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.time[mid] <= t) lo = mid;
      else hi = mid;
    }
    const f = (t - this.time[lo]) / (this.time[hi] - this.time[lo]);
    return this.arc[lo] + f * (this.arc[hi] - this.arc[lo]);
  }

  /** Camera pose at arc length `d`. The end pose is the eye looking level
   *  along the heading, to the floating-point precision of lookAt. */
  poseAt(d: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    const L = this.length;
    const dc = Math.min(L, Math.max(0, d));
    let lo = 0, hi = SAMPLES;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.arc[mid] <= dc) lo = mid;
      else hi = mid;
    }
    const span = this.arc[hi] - this.arc[lo];
    const f = span > 0 ? (dc - this.arc[lo]) / span : 0;
    this.point((lo + f) / SAMPLES, pos);
    if (dc >= L) pos.copy(this.pts[this.pts.length - 2]);
    // The gaze swings to the walker's line over the second half of the path.
    const w = smoothstep(0.45, 1, dc / L);
    this.tgt.copy(this.lookFrom).lerp(this.lookTo, w);
    this.m.lookAt(pos, this.tgt, this.tmp.set(0, 1, 0));
    quat.setFromRotationMatrix(this.m);
  }

  /** Height of the path above the spawn's ground at `d`, for tests. */
  heightAt(d: number): number {
    const p = new THREE.Vector3();
    this.poseAt(d, p, new THREE.Quaternion());
    return p.y - this.ground;
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** One playing of the intro: the clock, and the skip. */
export class IntroRun {
  private t = 0;
  private skipAt: number | null = null;
  private skipFrom = 0;
  private d = 0;
  done = false;

  constructor(readonly path: IntroPath) {}

  /** Finish the move over INTRO_SKIP_S from wherever it is now. */
  skip(): void {
    if (this.done || this.skipAt !== null) return;
    this.skipAt = this.t;
    this.skipFrom = this.d;
  }

  get skipping(): boolean {
    return this.skipAt !== null;
  }

  /** Advance and write the pose. Returns false once the move has ended; the
   *  pose written on that call is the final one. */
  update(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion): boolean {
    this.t += dt;
    if (this.skipAt !== null) {
      const u = Math.min(1, (this.t - this.skipAt) / INTRO_SKIP_S);
      this.d = this.skipFrom + (this.path.length - this.skipFrom) * smoothstep(0, 1, u);
      if (u >= 1) this.done = true;
    } else {
      this.d = this.path.distanceAt(this.t);
      if (this.t >= this.path.duration) this.done = true;
    }
    this.path.poseAt(this.done ? this.path.length : this.d, pos, quat);
    return !this.done;
  }
}

export interface PoseSample {
  dt: number;
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
}

/**
 * The continuity measure the intro checks share: the worst per-frame linear
 * and angular speed over a recorded trace. A cut shows up as one frame with
 * an enormous step; a smooth move never exceeds what its own speed profile
 * allows.
 */
export function traceContinuity(trace: readonly PoseSample[]): { maxSpeed: number; maxTurnDegS: number; maxStepM: number; maxStepDeg: number } {
  let maxSpeed = 0, maxTurnDegS = 0, maxStepM = 0, maxStepDeg = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1], b = trace[i];
    const step = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const dot = Math.min(1, Math.abs(a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw));
    const ang = (2 * Math.acos(dot) * 180) / Math.PI;
    const dt = Math.max(1e-4, b.dt);
    maxStepM = Math.max(maxStepM, step);
    maxStepDeg = Math.max(maxStepDeg, ang);
    maxSpeed = Math.max(maxSpeed, step / dt);
    maxTurnDegS = Math.max(maxTurnDegS, ang / dt);
  }
  return { maxSpeed, maxTurnDegS, maxStepM, maxStepDeg };
}

/** Bounds the path is held to at normal speed (not while skipping). */
export const INTRO_MAX_SPEED = 900;
export const INTRO_MAX_TURN_DEG_S = 45;
