// Pompeii's townsfolk as modelled figures: a 15-bone body lofted from rings,
// Roman dress as geometry over it, and the walk and stance that pose it.
// Pure (no THREE) so test/pompeii.check.ts can measure it under Bun;
// render/pompeiifolk.ts bakes the poses into a texture and skins the meshes
// in the vertex shader, and render/pompeiiorders.ts builds the Dancing Faun
// from the same body in a held pose.
//
// Proportions: 7.5 heads, 1.70 m at scale 1 (Pompeian men averaged about
// 1.66 m, women 1.54; the renderer scales each figure). +z forward, y up,
// +x the figure's LEFT, the soles on y = 0.
//
// Bones: 0 pelvis, 1 chest, 2 head, then thigh, shin, foot for the left and
// right legs, upper arm, forearm, hand for the left and right arms, and the
// two toes.

export type V3 = [number, number, number];
type RGB = [number, number, number];

export const FOLK_BONES = 17;
export const PELVIS = 0, CHEST = 1, HEAD = 2;
export const L_THIGH = 3, L_SHIN = 4, L_FOOT = 5, R_THIGH = 6, R_SHIN = 7, R_FOOT = 8;
export const L_ARM = 9, L_FORE = 10, L_HAND = 11, R_ARM = 12, R_FORE = 13, R_HAND = 14;
/** The toes bend at the ball, so a heel coming up does not push them into the ground. */
export const L_TOE = 15, R_TOE = 16;

/** Height of the scale-1 figure, metres. */
export const FOLK_HEIGHT_M = 1.7;
/**
 * Metres walked per gait cycle (two steps) at scale 1. data/pompeiilife.ts
 * advances a walker's phase 2 pi every 1.4 m, so a figure baked to this
 * stride keeps its planted foot still on the ground.
 */
export const FOLK_STRIDE_M = 1.4;
/** Each figure's scale is drawn from these ranges (men 1.63-1.76 m, women 1.52-1.62 m, boys 1.25-1.39 m). */
export const FOLK_SCALE = { man: [0.96, 1.04], woman: [0.9, 0.96], boy: [0.74, 0.82] } as const;
/** Pose frames baked per cycle. */
export const FOLK_FRAMES = 32;

/** Colour slots: what a vertex takes its colour from. */
export const SLOT_FIXED = 0, SLOT_SKIN = 1, SLOT_HAIR = 2, SLOT_CLOTH = 3, SLOT_CLOTH2 = 4;
/** A calceus: black or red-brown leather, picked per figure. */
export const SLOT_SHOE = 5;
/** Materials (the fragment shader's p1 for style 23). */
export const M_SKIN = 0, M_WOOL = 1, M_HAIR = 2, M_LEATHER = 3, M_CLAY = 4, M_WICKER = 5, M_WOOD = 6, M_FINE = 7;
/** A foot in a sandal: skin, with the sole's edge and the straps painted on in leather. */
export const M_SHOE = 8;
/** Surface style of the figures in the town shader. */
export const FOLK_STYLE = 23;
/** Instance flag bits. */
export const FLAG_TORCH = 1, FLAG_LONG = 2;
/** Barefoot: the sandal's sole hidden and its straps not painted. */
export const FLAG_BARE = 4;

// --- the skeleton (left side; the right is mirrored in x) --------------------------

const PELVIS_PIVOT: V3 = [0, 0.95, 0];
const CHEST_PIVOT: V3 = [0, 1.06, -0.01];
const NECK_PIVOT: V3 = [0, 1.45, -0.015];
const HIP: V3 = [0.09, 0.9, 0];
const KNEE: V3 = [0.095, 0.48, 0.012];
const ANKLE: V3 = [0.1, 0.085, -0.02];
const SHOULDER: V3 = [0.175, 1.39, -0.02];
const ELBOW: V3 = [0.2, 1.095, -0.045];
const WRIST: V3 = [0.21, 0.85, -0.015];
const HEEL_Z = ANKLE[2] - 0.055, BALL_Z = ANKLE[2] + 0.145, TOE_Z = ANKLE[2] + 0.205;

const mir = (p: V3, s: number): V3 => [p[0] * s, p[1], p[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const L = len(a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
const smooth = (t: number): number => { const u = clamp01(t); return u * u * (3 - 2 * u); };

const UPPER_ARM = len(sub(ELBOW, SHOULDER)), FOREARM = len(sub(WRIST, ELBOW));
const THIGH = len(sub(KNEE, HIP)), SHIN = len(sub(ANKLE, KNEE));

// --- 4x4 matrices, column-major as WebGL ------------------------------------------

type M4 = number[];
function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const tr = (p: V3): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1];
function rotAxis(ax: V3, a: number): M4 {
  const [x, y, z] = norm(ax), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}
/** The shortest-arc rotation taking direction a onto b. */
function rotFromTo(a: V3, b: V3): M4 {
  const u = norm(a), v = norm(b);
  const c = Math.max(-1, Math.min(1, dot(u, v)));
  const ax = cross(u, v);
  if (len(ax) < 1e-9) return c > 0 ? tr([0, 0, 0]) : rotAxis(Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0]), Math.PI);
  return rotAxis(ax, Math.acos(c));
}
/** Yaw about y, then pitch about x, then roll about z, applied to the vector in that reverse order. */
const euler = (yaw: number, pitch: number, roll: number): M4 => mul(rotAxis([0, 1, 0], yaw), mul(rotAxis([1, 0, 0], pitch), rotAxis([0, 0, 1], roll)));
const about = (p: V3, r: M4): M4 => mul(tr(p), mul(r, tr(scl(p, -1))));
const apply = (m: M4, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const applyDir = (m: M4, p: V3): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
/** A bone that turned by r about its joint and moved the joint from `rest` to `at`. */
const boneAt = (rest: V3, at: V3, r: M4): M4 => mul(tr(at), mul(r, tr(scl(rest, -1))));

/** Two-bone IK: the middle joint and the reached end, bending toward `pole`. */
function ik(root: V3, target: V3, a: number, b: number, pole: V3): { mid: V3; end: V3 } {
  const d0 = sub(target, root);
  const dir = norm(d0);
  const d = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-4, len(d0)));
  const ca = (a * a + d * d - b * b) / (2 * a * d);
  const along = a * ca, perp = a * Math.sqrt(Math.max(0, 1 - ca * ca));
  let pd = sub(pole, scl(dir, dot(pole, dir)));
  if (len(pd) < 1e-6) pd = Math.abs(dir[1]) < 0.9 ? cross(dir, [0, 1, 0]) : cross(dir, [1, 0, 0]);
  pd = norm(pd);
  return { mid: add(root, add(scl(dir, along), scl(pd, perp))), end: add(root, scl(dir, d)) };
}

// --- poses ------------------------------------------------------------------------

export interface FootPose { ankle: V3; pitch: number }
export interface PoseSpec {
  hip: V3;
  pelvis: [number, number, number];
  chest: [number, number, number];
  head: [number, number, number];
  /** Left, right. */
  feet: [FootPose, FootPose];
  /** Wrist targets in the chest's rest frame, and the way each elbow points. */
  wrists: [V3, V3];
  poles: [V3, V3];
  /** Extra hand turn (radians about the forearm's side axis), left and right. */
  handBend?: [number, number];
}

/** Bone matrices (16 floats each, column-major) for a pose. */
export function solvePose(spec: PoseSpec, out = new Float32Array(FOLK_BONES * 16)): Float32Array {
  const set = (k: number, m: M4): void => { for (let i = 0; i < 16; i++) out[k * 16 + i] = m[i]; };
  const mp = mul(tr(spec.hip), about(PELVIS_PIVOT, euler(...spec.pelvis)));
  const mc = mul(mp, about(CHEST_PIVOT, euler(...spec.chest)));
  const mh = mul(mc, about(NECK_PIVOT, euler(...spec.head)));
  set(PELVIS, mp); set(CHEST, mc); set(HEAD, mh);
  for (const s of [1, -1]) {
    const li = s > 0 ? 0 : 1;
    const f = spec.feet[li];
    const hip = apply(mp, mir(HIP, s));
    // Knees point forward and a little out, as the hips turn.
    const pole = norm(add(applyDir(mp, [0.15 * s, 0, 1]), [0, 0.2, 0]));
    const { mid: K, end: A } = ik(hip, f.ankle, THIGH, SHIN, pole);
    const kr = mir(KNEE, s), ar = mir(ANKLE, s), hr = mir(HIP, s);
    set(s > 0 ? L_THIGH : R_THIGH, boneAt(hr, hip, rotFromTo(sub(kr, hr), sub(K, hip))));
    set(s > 0 ? L_SHIN : R_SHIN, boneAt(kr, K, rotFromTo(sub(ar, kr), sub(A, K))));
    const fm = boneAt(ar, A, footRot(f.pitch, s));
    set(s > 0 ? L_FOOT : R_FOOT, fm);
    const ball: V3 = [ANKLE[0] * s, 0, BALL_Z];
    set(s > 0 ? L_TOE : R_TOE, boneAt(ball, apply(fm, ball), footRot(Math.max(0, f.pitch), s)));
  }
  for (const s of [1, -1]) {
    const li = s > 0 ? 0 : 1;
    const S = apply(mc, mir(SHOULDER, s));
    const W = apply(mc, spec.wrists[li]);
    const { mid: E, end: Wr } = ik(S, W, UPPER_ARM, FOREARM, applyDir(mc, spec.poles[li]));
    const sr = mir(SHOULDER, s), er = mir(ELBOW, s), wr = mir(WRIST, s);
    const rf = rotFromTo(sub(wr, er), sub(Wr, E));
    set(s > 0 ? L_ARM : R_ARM, boneAt(sr, S, rotFromTo(sub(er, sr), sub(E, S))));
    set(s > 0 ? L_FORE : R_FORE, boneAt(er, E, rf));
    const bend = spec.handBend ? spec.handBend[li] : 0;
    const side = norm(cross(sub(Wr, E), [0, 0, 1]));
    set(s > 0 ? L_HAND : R_HAND, boneAt(wr, Wr, bend ? mul(rotAxis(side, bend * s), rf) : rf));
  }
  return out;
}

/** The foot's turn: toes out a little, pitched toe-up by `pitch`. */
const footRot = (pitch: number, s: number): M4 => mul(rotAxis([0, 1, 0], 0.08 * s), rotAxis([1, 0, 0], -pitch));

/** Ankle of a foot whose sole point `pivotZ` (rest z, on y 0) sits at `at`, pitched by `pitch`. */
function ankleFrom(at: V3, pivotZ: number, pitch: number, s: number): V3 {
  const rel = sub(mir(ANKLE, s), [ANKLE[0] * s, 0, pivotZ]);
  return add(at, applyDir(footRot(pitch, s), rel));
}

export const enum Gait { Walk = 0, Idle = 1 }
/** What the arms do: swing free, a woman's shorter swing, the toga's held fold, or a load. */
export const enum Arms { Free = 0, Woman = 1, Toga = 2, Amphora = 3, Basket = 4, Lantern = 5, Torch = 6 }
export const ARM_STYLES = 7;
export const FOLK_CLIPS = 2 * ARM_STYLES;
export const clipRow = (gait: Gait, arms: Arms): number => (gait * ARM_STYLES + arms) * FOLK_FRAMES;

const STANCE = 0.6;
/** Heel ahead of the hip at heel strike, metres. */
const STRIKE_Z = 0.27;
const STRIKE_PITCH = 0.25, OFF_PITCH = 0.85;
const ROLL_IN = 0.08, ROLL_OFF = 0.22;
const STEP_X = 0.07;

/** A walking foot at its own phase (0 = heel strike), x = side. */
function walkFoot(phi: number, s: number): FootPose {
  const x = STEP_X * s;
  const stance = (f: number): FootPose => {
    const heelZ = STRIKE_Z - FOLK_STRIDE_M * f;
    if (f < ROLL_IN) {
      const pitch = STRIKE_PITCH * (1 - f / ROLL_IN) ** 2;
      return { ankle: ankleFrom([x, 0, heelZ], HEEL_Z, pitch, s), pitch };
    }
    if (f < STANCE - ROLL_OFF) return { ankle: ankleFrom([x, 0, heelZ], HEEL_Z, 0, s), pitch: 0 };
    const q = (f - (STANCE - ROLL_OFF)) / ROLL_OFF;
    const pitch = -OFF_PITCH * q ** 1.5;
    return { ankle: ankleFrom([x, 0, heelZ + BALL_Z - HEEL_Z], BALL_Z, pitch, s), pitch };
  };
  if (phi < STANCE) return stance(phi);
  const u = (phi - STANCE) / (1 - STANCE);
  const a0 = stance(STANCE), a1 = stance(0);
  const z = lerp(a0.ankle[2], a1.ankle[2], 0.5 - 0.5 * Math.cos(Math.PI * u));
  // The foot lifts most early in the swing, when the toe trails lowest.
  const y = lerp(a0.ankle[1], a1.ankle[1], u) + 0.075 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8;
  const pitch = lerp(-OFF_PITCH, STRIKE_PITCH, smooth((u - 0.12) / 0.6));
  return { ankle: [x, y, z], pitch };
}

/** Highest hip lift (above the rest pose) each pelvis pose allows, by bisection: the planted feet must reach. */
function hipLift(pelvis: [number, number, number], dx: number, feet: (FootPose | null)[], cap: number): number {
  const reach = THIGH + SHIN - 0.004;
  let lo = -0.2, hi = cap;
  const ok = (dy: number): boolean => {
    const mp = mul(tr([dx, dy, 0]), about(PELVIS_PIVOT, euler(...pelvis)));
    return feet.every((f, li) => !f || len(sub(f.ankle, apply(mp, mir(HIP, li === 0 ? 1 : -1)))) <= reach);
  };
  if (ok(hi)) return hi;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return lo;
}

interface Body { hip: V3; pelvis: [number, number, number]; chest: [number, number, number]; head: [number, number, number]; feet: [FootPose, FootPose] }

const walkPelvis = (p: number): { dx: number; pelvis: [number, number, number] } => {
  const w = 2 * Math.PI * p;
  // The left hip comes forward with the left foot, and rides up over it in stance.
  return { dx: 0.018 * Math.sin(w), pelvis: [-0.07 * Math.cos(w), 0.03, 0.045 * Math.sin(w)] };
};

let walkLift: number[] | null = null;
/** The hip's rise and fall through the cycle: as high as the planted feet allow, smoothed. */
function walkLiftTable(): number[] {
  if (walkLift) return walkLift;
  const N = 128, raw: number[] = [];
  for (let k = 0; k < N; k++) {
    const p = k / N;
    const { dx, pelvis } = walkPelvis(p);
    const phiL = p, phiR = (p + 0.5) % 1;
    raw.push(hipLift(pelvis, dx, [phiL < STANCE ? walkFoot(phiL, 1) : null, phiR < STANCE ? walkFoot(phiR, -1) : null], -0.012));
  }
  // An erosion then a blur of the same width: smooth, and never above the limit.
  const W = 5;
  const er = raw.map((_, k) => { let m = Infinity; for (let d = -W; d <= W; d++) m = Math.min(m, raw[(k + d + N) % N]); return m; });
  walkLift = er.map((_, k) => { let s = 0; for (let d = -W; d <= W; d++) s += er[(k + d + N) % N]; return s / (2 * W + 1); });
  return walkLift;
}

function walkBody(p: number): Body {
  const t = walkLiftTable(), N = t.length;
  const f = p * N, k = Math.floor(f) % N;
  const dy = lerp(t[k], t[(k + 1) % N], f - Math.floor(f));
  const { dx, pelvis } = walkPelvis(p);
  const w = 2 * Math.PI * p;
  return {
    hip: [dx, dy, 0], pelvis,
    // The shoulders turn against the hips, the head stays on the path.
    chest: [0.13 * Math.cos(w), 0.04, -0.03 * Math.sin(w)],
    head: [-0.05 * Math.cos(w), -0.07, -0.01 * Math.sin(w)],
    feet: [walkFoot(p, 1), walkFoot((p + 0.5) % 1, -1)],
  };
}

/** Weight on the right leg, the left knee eased forward; `p` drifts the sway and the gaze. */
function idleBody(p: number): Body {
  const w = 2 * Math.PI * p;
  const right: FootPose = { ankle: ankleFrom([-0.085, 0, -0.01], HEEL_Z, 0, -1), pitch: 0 };
  const lp = -0.12;
  const left: FootPose = { ankle: ankleFrom([0.15, 0, 0.1 + BALL_Z - HEEL_Z], BALL_Z, lp, 1), pitch: lp };
  const dx = -0.035 + 0.008 * Math.sin(w);
  const pelvis: [number, number, number] = [0.06, 0.02, -0.055 + 0.01 * Math.sin(w)];
  const dy = hipLift(pelvis, dx, [left, right], -0.008) - 0.004;
  return {
    hip: [dx, dy, 0], pelvis,
    chest: [-0.05, 0.03, 0.07 - 0.012 * Math.sin(w)],
    head: [0.35 * Math.sin(w * 2 + 1), -0.05 + 0.04 * Math.sin(w * 3), 0.04],
    feet: [left, right],
  };
}

/** A hanging arm's wrist in the chest's rest frame: flexed forward, out to the side, the elbow bent. */
function armAt(s: number, flex: number, abd: number, elbow: number): V3 {
  const d = (a: number): V3 => applyDir(mul(rotAxis([0, 0, 1], abd * s), rotAxis([1, 0, 0], -a)), [0, -1, 0]);
  const sh = mir(SHOULDER, s);
  return add(add(sh, scl(d(flex), UPPER_ARM)), scl(d(flex + elbow), FOREARM));
}

const BACK_POLE = (s: number): V3 => [0.35 * s, -0.2, -1];

/** One frame of a clip. */
export function clipPose(gait: Gait, arms: Arms, p: number): PoseSpec {
  const b = gait === Gait.Walk ? walkBody(p) : idleBody(p);
  const w = 2 * Math.PI * p;
  const walking = gait === Gait.Walk;
  // The arms swing against the legs: the left forward as the right foot is.
  const swing = (s: number, A: number): V3 => {
    const ph = walking ? -s * Math.cos(w) : 0;
    const flex = A * ph - 0.04;
    return armAt(s, flex, 0.07, 0.22 + (walking ? 0.25 * Math.max(0, ph) : 0.05));
  };
  const A = arms === Arms.Woman ? 0.16 : arms === Arms.Free ? 0.3 : 0.22;
  let wl = swing(1, A), wr = swing(-1, A);
  let pl = BACK_POLE(1), pr = BACK_POLE(-1);
  let bend: [number, number] = [0, 0];
  switch (arms) {
    case Arms.Toga:
      // The left forearm across the waist, carrying the toga's folds.
      wl = armAt(1, 0.15, 0.06, 1.35);
      break;
    case Arms.Amphora:
      // Steadying the amphora on the left shoulder by its neck.
      wl = [0.22, 1.62, 0.2]; pl = [1, -0.6, -0.2]; bend = [0.6, 0];
      break;
    case Arms.Basket:
      wr = [-0.15, 1.74, 0.03]; pr = [-1, -0.3, -0.1]; bend = [0, 0.4];
      break;
    case Arms.Lantern:
      wr = [-0.3, 0.9, 0.12]; pr = [-0.5, 0, -1];
      break;
    case Arms.Torch:
      wr = [-0.2, 1.86, 0.1]; pr = [-1, -0.2, -0.3];
      break;
  }
  return { ...b, wrists: [wl, wr], poles: [pl, pr], handBend: bend };
}

/** Every clip's frames, bone by bone: 3 rows of the affine matrix per bone, as the pose texture holds them. */
export function bakeClips(): Float32Array {
  const W = FOLK_BONES * 3 * 4, out = new Float32Array(FOLK_CLIPS * FOLK_FRAMES * W);
  const m = new Float32Array(FOLK_BONES * 16);
  for (const gait of [Gait.Walk, Gait.Idle]) for (let a = 0; a < ARM_STYLES; a++) for (let f = 0; f < FOLK_FRAMES; f++) {
    solvePose(clipPose(gait, a as Arms, f / FOLK_FRAMES), m);
    const row = clipRow(gait, a as Arms) + f;
    for (let b = 0; b < FOLK_BONES; b++) for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
      out[row * W + (b * 3 + r) * 4 + c] = m[b * 16 + c * 4 + r];
    }
  }
  return out;
}

/** Heel and toe of each foot in a pose, model space: [lx heel, l toe, r heel, r toe]. */
export function solePoints(bones: Float32Array): V3[] {
  const out: V3[] = [];
  for (const s of [1, -1]) {
    const bone = (b: number): M4 => Array.from(bones.subarray(b * 16, b * 16 + 16));
    out.push(apply(bone(s > 0 ? L_FOOT : R_FOOT), [ANKLE[0] * s, 0, HEEL_Z]));
    for (const z of [BALL_Z, TOE_Z]) out.push(apply(bone(s > 0 ? L_TOE : R_TOE), [ANKLE[0] * s, 0, z]));
  }
  return out;
}

// --- the mesh ---------------------------------------------------------------------

export interface FolkMesh {
  position: Float32Array;
  normal: Int8Array;
  /** rgb fixed colour or a multiplier on the slot's colour, a: seed. */
  colour: Uint8Array;
  /** style, material, fold count, colour slot. */
  surf: Uint8Array;
  /** bone a, b, c, unused. */
  skin: Uint8Array;
  /** weights of a, b, c (0..255), mask: 1 = only with FLAG_TORCH. */
  weight: Uint8Array;
  /** u round, v along, fold depth, hem drop (metres) for a long garment at the far LOD. */
  wall: Float32Array;
  index: Uint16Array;
  triangles: number;
}

interface Skin { b: [number, number, number]; w: [number, number, number] }
const one = (b: number): Skin => ({ b: [b, b, b], w: [1, 0, 0] });
const two = (a: number, b: number, t: number): Skin => ({ b: [a, b, a], w: [1 - t, t, 0] });
interface Attr { slot: number; mat: number; c?: RGB; folds?: number; depth?: number; skin: Skin; mask?: number; drop?: number }
type AttrFn = (p: V3, k: number, j: number, m: number) => Attr;

/** Set while the middle level of detail is built: fewer sides and rings, no small parts. */
let LOW = false;

class Builder {
  pos: number[] = []; col: number[] = []; surf: number[] = []; skin: number[] = []; wt: number[] = []; wall: number[] = []; nrm: number[] = [];
  idx: number[] = [];
  style = FOLK_STYLE;
  private vert(p: V3, a: Attr, u: number, v: number): number {
    const i = this.pos.length / 3;
    const c = a.c ?? [1, 1, 1];
    this.pos.push(...p); this.nrm.push(0, 0, 0);
    this.col.push(c[0], c[1], c[2]);
    this.surf.push(this.style, a.mat, a.folds ?? 0, a.slot);
    this.skin.push(a.skin.b[0], a.skin.b[1], a.skin.b[2], 0);
    this.wt.push(Math.round(a.skin.w[0] * 255), Math.round(a.skin.w[1] * 255), Math.round(a.skin.w[2] * 255), a.mask ?? 0);
    this.wall.push(u, v, a.depth ?? 0, a.drop ?? 0);
    return i;
  }
  /**
   * Rings lofted into a tube, each ring one vertex longer than its points
   * (the seam is doubled so u runs 0..1 for the folds), capped to a point
   * on request. Normals are this loft's own and point away from the rings' centres.
   */
  loft(rings: V3[][], attr: AttrFn, capStart: boolean, capEnd: boolean, tips: [V3 | null, V3 | null] = [null, null]): void {
    const m = rings[0].length, base = this.pos.length / 3, i0 = this.idx.length;
    rings.forEach((r, k) => { for (let j = 0; j <= m; j++) this.vert(r[j % m], attr(r[j % m], k, j % m, m), j / m, k / Math.max(1, rings.length - 1)); });
    const w = m + 1;
    for (let k = 0; k + 1 < rings.length; k++) for (let j = 0; j < m; j++) {
      const a = base + k * w + j, b = a + 1, c = a + w, d = c + 1;
      this.idx.push(a, c, b, b, c, d);
    }
    const centre = (r: V3[]): V3 => scl(r.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / r.length);
    const cap = (k: number, tip: V3 | null): void => {
      const r = rings[k], c = tip ?? centre(r);
      const ci = this.vert(c, attr(c, k, 0, m), 0.5, k / Math.max(1, rings.length - 1));
      for (let j = 0; j < m; j++) this.idx.push(ci, base + k * w + j + 1, base + k * w + j);
    };
    if (capStart) cap(0, tips[0]);
    if (capEnd) cap(rings.length - 1, tips[1]);
    this.normals(i0, base, rings.map(centre));
    // Close the seam: the doubled vertices share one normal.
    for (let k = 0; k < rings.length; k++) {
      const a = base + k * w, b = a + m;
      for (let q = 0; q < 3; q++) { const s = this.nrm[a * 3 + q] + this.nrm[b * 3 + q]; this.nrm[a * 3 + q] = s; this.nrm[b * 3 + q] = s; }
    }
  }
  /** Face normals summed onto the loft's vertices, the winding turned outward if it came out inward. */
  private normals(i0: number, base: number, centres: V3[]): void {
    const n = this.pos.length / 3;
    const P = (i: number): V3 => [this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]];
    let out = 0;
    const acc = (): void => {
      for (let i = base * 3; i < n * 3; i++) this.nrm[i] = 0;
      for (let t = i0; t < this.idx.length; t += 3) {
        const a = this.idx[t], b = this.idx[t + 1], c = this.idx[t + 2];
        const f = cross(sub(P(b), P(a)), sub(P(c), P(a)));
        for (const v of [a, b, c]) for (let q = 0; q < 3; q++) this.nrm[v * 3 + q] += f[q];
      }
    };
    acc();
    const w = centres.length ? (n - base) / centres.length : 1;
    for (let i = base; i < n; i++) {
      const k = Math.min(centres.length - 1, Math.floor((i - base) / w));
      out += dot([this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]], sub(P(i), centres[k]));
    }
    if (out < 0) {
      for (let t = i0; t < this.idx.length; t += 3) { const b = this.idx[t + 1]; this.idx[t + 1] = this.idx[t + 2]; this.idx[t + 2] = b; }
      acc();
    }
  }
  finish(): FolkMesh {
    const n = this.pos.length / 3;
    const normal = new Int8Array(n * 4), colour = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const L = Math.hypot(this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]) || 1;
      for (let k = 0; k < 3; k++) normal[i * 4 + k] = Math.round((this.nrm[i * 3 + k] / L) * 127);
      for (let k = 0; k < 3; k++) colour[i * 4 + k] = Math.round(clamp01(this.col[i * 3 + k]) * 255);
      colour[i * 4 + 3] = 128;
    }
    return {
      position: new Float32Array(this.pos), normal, colour, surf: new Uint8Array(this.surf), skin: new Uint8Array(this.skin),
      weight: new Uint8Array(this.wt), wall: new Float32Array(this.wall), index: new Uint16Array(this.idx), triangles: this.idx.length / 3,
    };
  }
}

/**
 * A ring of m points round c in the plane of X (across) and Z (front):
 * point 0 at the front, half width hw, front and back depths f and b.
 */
function ring(c: V3, X: V3, Z: V3, hw: number, f: number, b: number, m: number, e = 2, bump?: (j: number) => number): V3[] {
  const out: V3[] = [];
  for (let j = 0; j < m; j++) {
    const a = (j / m) * Math.PI * 2, sa = Math.sin(a), ca = Math.cos(a);
    const r = 1 + (bump ? bump(j) : 0);
    const x = hw * r * Math.sign(sa) * Math.abs(sa) ** (2 / e);
    const z = (ca > 0 ? f : b) * r * Math.sign(ca) * Math.abs(ca) ** (2 / e);
    out.push(add(c, add(scl(X, x), scl(Z, z))));
  }
  return out;
}
const flat = (y: number, zc: number, hw: number, f: number, b: number, m: number, e = 2, x = 0, bump?: (j: number) => number): V3[] => ring([x, y, zc], [1, 0, 0], [0, 0, 1], hw, f, b, m, e, bump);

/** Rings along a polyline (limbs): frame Z is `fwd` made square to the line. */
function along(path: V3[], prof: [number, number, number][], m: number, fwd: V3, e = 2): V3[][] {
  return path.map((c, k) => {
    const t = norm(sub(path[Math.min(path.length - 1, k + 1)], path[Math.max(0, k - 1)]));
    const Z = norm(sub(fwd, scl(t, dot(fwd, t))));
    const X = norm(cross(Z, t));
    return ring(c, X, Z, prof[k][0], prof[k][1], prof[k][2], m, e);
  });
}

// --- skin weights -----------------------------------------------------------------

/** Upper body: pelvis to chest up the waist, the shoulders of a garment drawn by the arms. */
function torsoSkin(p: V3): Skin {
  const wc = smooth((p[1] - 0.98) / 0.16);
  const wa = p[1] > 1.22 ? 0.55 * smooth((Math.abs(p[0]) - 0.13) / 0.08) * smooth((p[1] - 1.22) / 0.12) : 0;
  return { b: [PELVIS, CHEST, p[0] >= 0 ? L_ARM : R_ARM], w: [1 - wc, wc * (1 - wa), wc * wa] };
}
/** A skirt: each side drawn by its thigh, more toward the hem; k how freely the cloth follows. */
function skirtSkin(p: V3, k: number): Skin {
  const d = smooth((0.93 - p[1]) / 0.45);
  const wl = k * d * smooth((p[0] + 0.06) / 0.18), wr = k * d * smooth((-p[0] + 0.06) / 0.18);
  return { b: [PELVIS, L_THIGH, R_THIGH], w: [1 - wl - wr, wl, wr] };
}
const garmentSkin = (p: V3, k: number): Skin => (p[1] < 0.95 ? skirtSkin(p, k) : torsoSkin(p));

// --- body parts -------------------------------------------------------------------

export interface FolkOpts {
  dress: "tunic" | "stola" | "toga" | "nude";
  load?: "amphora" | "basket";
  veil?: boolean;
  /** The Dancing Faun's horns, ears and tail. */
  faun?: boolean;
}

const HEAD_ROWS: [number, number, number, number, number][] = [
  // y, half width, front, back, centre z
  [1.457, 0.034, 0.028, 0.022, 0.05],
  [1.482, 0.056, 0.052, 0.045, 0.032],
  [1.52, 0.066, 0.078, 0.074, 0.016],
  [1.56, 0.072, 0.09, 0.094, 0.01],
  [1.597, 0.076, 0.096, 0.1, 0.005],
  [1.633, 0.077, 0.094, 0.1, 0],
  [1.668, 0.069, 0.078, 0.088, -0.006],
  [1.692, 0.046, 0.046, 0.06, -0.012],
];

/** The head: a face in profile (chin, mouth, nose, brow), ears, the hair as a cap over it. */
function head(B: Builder, o: FolkOpts): void {
  const m = 12;
  const woman = o.dress === "stola";
  const hairRow = (y: number, j: number): boolean => {
    const a = Math.min(j / m, 1 - j / m) * 2; // 0 front .. 1 back
    const line = a < 0.2 ? 1.648 : a < 0.4 ? 1.62 : a < 0.6 ? 1.585 : 1.52;
    return y > line - (woman ? 0.006 : 0);
  };
  const rings = HEAD_ROWS.map(([y, hw, f, b, zc], k) => flat(y, zc, hw, f, b, m, 2.2, 0, (j) => {
    let r = 0;
    // j 0 is the front: the nose and the chin stand out of the oval, the ears beside it.
    if (j === 0) r += k === 1 ? 0.18 : k === 2 ? 0.06 : k === 3 ? 0.27 : k === 4 ? 0.12 : k === 5 ? 0.05 : 0;
    if ((j === 1 || j === m - 1) && k === 4) r -= 0.06;
    if ((j === 3 || j === 9) && (k === 3 || k === 4)) r += o.faun ? 0.3 : 0.17;
    if (hairRow(y, j)) r += woman ? 0.1 : o.faun ? 0.16 : 0.07;
    return r;
  }));
  // The face's eyes, brows and mouth are painted by the fragment shader from
  // u round and v up the head (p2 1 marks it); see FOLK_SHADING.
  B.loft(rings, (_p, k, j) => {
    const hair = hairRow(HEAD_ROWS[k][0], j);
    return { slot: hair ? SLOT_HAIR : SLOT_SKIN, mat: hair ? M_HAIR : M_SKIN, folds: hair ? 0 : 1, skin: one(HEAD) };
  }, true, true);
  if (woman && !o.veil && !o.load) {
    // Hair drawn back into a bun at the nape.
    // Lofted front to back: rings stacked along -z.
    const bun = [0, 1, 2, 3].map((k) => ring([0, 1.585, -0.09 - k * 0.022], [1, 0, 0], [0, 1, 0], [0.022, 0.042, 0.042, 0.02][k], [0.02, 0.036, 0.036, 0.018][k], [0.02, 0.036, 0.036, 0.018][k], 7));
    B.loft(bun, () => ({ slot: SLOT_HAIR, mat: M_HAIR, skin: one(HEAD) }), false, true);
  }
  if (o.faun) {
    // Two small horns out of the curls over the brow.
    for (const s of [1, -1]) {
      const path: V3[] = [[0.028 * s, 1.655, 0.065], [0.036 * s, 1.69, 0.06], [0.042 * s, 1.715, 0.045]];
      B.loft(along(path, [[0.012, 0.012, 0.012], [0.008, 0.008, 0.008], [0.002, 0.002, 0.002]], 5, [0, 0, 1]), () => ({ slot: SLOT_SKIN, mat: M_SKIN, skin: one(HEAD) }), true, false);
    }
  }
}

/** The neck from inside the collar into the head. */
function neck(B: Builder): void {
  const rs = [flat(1.39, -0.025, 0.056, 0.05, 0.055, 8), flat(1.5, -0.005, 0.05, 0.045, 0.05, 8)];
  B.loft(rs, (p) => ({ slot: SLOT_SKIN, mat: M_SKIN, skin: two(CHEST, HEAD, smooth((p[1] - 1.43) / 0.06)) }), false, false);
}

/** An arm from `fromT` of the way down the upper arm to the wrist, then the hand. */
function arm(B: Builder, s: number, fromT: number, slotUpper = SLOT_SKIN, matUpper = M_SKIN, wrap = 0): void {
  const sh = mir(SHOULDER, s), el = mir(ELBOW, s), wr = mir(WRIST, s);
  // A bare shoulder (the faun) needs the deltoid's ring; under a sleeve the upper arm is one span.
  const bare = fromT < 0.2 && wrap === 0;
  const path: V3[] = bare ? [lerp3(sh, el, fromT), lerp3(sh, el, 0.55), el, lerp3(el, wr, 0.4), wr] : [lerp3(sh, el, fromT), el, lerp3(el, wr, 0.4), wr];
  const r = (a: number): [number, number, number] => [a + wrap, a + wrap, a + wrap];
  const fore: [number, number, number] = [0.04 + wrap, 0.042 + wrap, 0.038 + wrap];
  const prof = bare ? [r(0.05), [0.045, 0.042, 0.05] as [number, number, number], r(0.038), fore, r(0.028)] : [r(0.047), r(0.038), fore, r(0.028)];
  const bones = [s > 0 ? L_ARM : R_ARM, s > 0 ? L_FORE : R_FORE];
  const kEl = bare ? 2 : 1;
  // The middle level keeps the shoulder, elbow and wrist rings only.
  if (LOW && !bare) { path.splice(2, 1); prof.splice(2, 1); }
  B.loft(along(path, prof, LOW ? 5 : 8, [0, 0, 1]), (_p, k) => {
    const skin = k === 0 && fromT < 0.2 ? two(CHEST, bones[0], 0.65) : k < kEl ? one(bones[0]) : k === kEl ? two(bones[0], bones[1], 0.5) : one(bones[1]);
    const covered = wrap > 0 && k < path.length - 1;
    return { slot: covered ? slotUpper : SLOT_SKIN, mat: covered ? matUpper : M_SKIN, folds: covered ? 5 : 0, depth: covered ? 0.6 : 0, skin };
  }, false, false);
  hand(B, s);
}

/** A hand hanging from the wrist: palm toward the thigh, fingers a little curled, the thumb forward. */
function hand(B: Builder, s: number): void {
  const wr = mir(WRIST, s);
  const dn = norm(sub(wr, mir(ELBOW, s)));
  const pt = (d: number, inward: number, fwd: number): V3 => add(wr, add(scl(dn, d), [-s * inward, 0, fwd]));
  const path: V3[] = [pt(-0.01, 0, 0), pt(0.07, 0.002, 0.005), pt(0.165, 0.016, 0.004)];
  // Across the palm (z) wider than through it (x): the ring's X axis runs through the palm.
  const prof: [number, number, number][] = [[0.022, 0.026, 0.026], [0.015, 0.046, 0.038], [0.01, 0.03, 0.026]];
  if (LOW) { path.splice(1, 1); prof.splice(1, 1); }
  B.loft(along(path, prof, LOW ? 3 : 6, [0, 0, 1], 2.4), () => ({ slot: SLOT_SKIN, mat: M_SKIN, skin: one(s > 0 ? L_HAND : R_HAND) }), false, true);
}

/** The inside of a leg darker: the gap between the legs gets little sky. */
function innerShade(p: V3, s: number): RGB {
  const k = 1 - 0.3 * smooth((ANKLE[0] - p[0] * s) / 0.05);
  return [k, k, k];
}

/** A leg from height `topY` down through the knee to the ankle. */
function leg(B: Builder, s: number, topY: number, slot = SLOT_SKIN): void {
  const hp = mir(HIP, s), kn = mir(KNEE, s), an = mir(ANKLE, s);
  const tT = (hp[1] - topY) / (hp[1] - kn[1]);
  // A whole thigh (the faun) is shaped down to the knee; under a skirt only its foot shows.
  const whole = tT < 0.2;
  if (topY < kn[1]) {
    // Under a long garment: the shin from the hem down.
    const tS = (kn[1] - topY) / (kn[1] - an[1]);
    const shin = s > 0 ? L_SHIN : R_SHIN, ftb = s > 0 ? L_FOOT : R_FOOT;
    B.loft(along([lerp3(kn, an, tS), lerp3(kn, an, Math.max(tS + 0.1, 0.72)), an], [[0.045, 0.045, 0.055], [0.036, 0.038, 0.04], [0.031, 0.034, 0.032]], LOW ? 5 : 7, [0, 0, 1]), (p, k) => ({
      slot, mat: M_SKIN, c: innerShade(p, s), skin: k === 2 ? two(shin, ftb, 0.3) : one(shin),
    }), false, false);
    return;
  }
  const path: V3[] = whole
    ? [lerp3(hp, kn, tT), lerp3(hp, kn, 0.6), kn, lerp3(kn, an, 0.3), lerp3(kn, an, 0.7), an]
    : [lerp3(hp, kn, tT), kn, lerp3(kn, an, 0.3), lerp3(kn, an, 0.72), an];
  const profAll: [number, number, number][] = whole
    ? [[0.085, 0.085, 0.09], [0.068, 0.07, 0.068], [0.05, 0.055, 0.048], [0.052, 0.05, 0.068], [0.036, 0.038, 0.04], [0.031, 0.034, 0.032]]
    : [[lerp(0.085, 0.05, tT), lerp(0.085, 0.055, tT), lerp(0.09, 0.05, tT)], [0.05, 0.055, 0.048], [0.052, 0.05, 0.068], [0.036, 0.038, 0.04], [0.031, 0.034, 0.032]];
  // The middle level keeps the thigh, knee, calf and ankle.
  if (LOW && !whole) { path.splice(4, 1); profAll.splice(4, 1); }
  const kIdx = whole ? 2 : 1;
  const th = s > 0 ? L_THIGH : R_THIGH, sh = s > 0 ? L_SHIN : R_SHIN, ft = s > 0 ? L_FOOT : R_FOOT;
  B.loft(along(path, profAll, LOW ? 5 : whole ? 8 : 7, [0, 0, 1]), (p, k) => ({
    slot, mat: M_SKIN, c: innerShade(p, s),
    skin: k < kIdx ? (tT < 0.2 && k === 0 ? two(PELVIS, th, 0.6) : one(th)) : k === kIdx ? two(th, sh, 0.5) : k === path.length - 1 ? two(sh, ft, 0.3) : one(sh),
  }), false, false);
}

/**
 * A foot: a rounded heel, the instep over a raised arch, the ball, and a
 * squared block of toes. "sandal" puts a leather sole under it and leaves
 * the straps to the shader (M_SHOE, hidden and bared for FLAG_BARE);
 * "calceus" is the closed leather shoe to the ankle the toga was worn with.
 */
function foot(B: Builder, s: number, mode: "sandal" | "calceus" | "bare"): void {
  const x = ANKLE[0] * s;
  const shoe = mode === "calceus" ? 0.006 : 0;
  const rows: [number, number, number, number, number][] = [
    // z, centre y, half width, up, down
    [HEEL_Z + 0.012, 0.042, 0.028, 0.032, 0.04],
    [ANKLE[2] + 0.03, 0.057, 0.034, 0.05, 0.055],
    // The arch: the sole lifts off the ground under the instep.
    [ANKLE[2] + 0.09, 0.042, 0.038, 0.034, 0.03],
    [BALL_Z + 0.005, 0.025, 0.046, 0.021, 0.023],
    [TOE_Z - 0.006, 0.016, 0.04, 0.013, 0.014],
  ];
  const m = LOW ? 4 : 7;
  const rs = rows.filter((_, k) => !LOW || k === 0 || k === 3 || k === 4).map(([z, y, hw, up, dn]) => ring([x, y, z], [1, 0, 0], [0, 1, 0], hw + shoe, up + shoe, dn, m, 2.6));
  const ft = s > 0 ? L_FOOT : R_FOOT, toe = s > 0 ? L_TOE : R_TOE, shin = s > 0 ? L_SHIN : R_SHIN;
  const nr = rs.length;
  const skinAt = (k: number): Skin => (k === 0 ? two(ft, shin, 0.15) : k === 1 ? two(ft, shin, 0.3) : k < nr - 2 ? one(ft) : k === nr - 2 ? two(ft, toe, 0.6) : one(toe));
  const look = (): { slot: number; mat: number } => (mode === "calceus" ? { slot: SLOT_SHOE, mat: M_LEATHER } : mode === "sandal" ? { slot: SLOT_SKIN, mat: M_SHOE } : { slot: SLOT_SKIN, mat: M_SKIN });
  B.loft(rs, (_p, k) => ({ ...look(), skin: skinAt(k) }), true, true, [null, [x, 0.014, TOE_Z]]);
  if (mode === "calceus") {
    // The shoe's upper round the ankle, laced.
    const an = mir(ANKLE, s);
    const cuff = [0.045, 0.13].map((y) => ring([an[0], y, an[2] + 0.005], [1, 0, 0], [0, 0, 1], 0.04, 0.045, 0.043, m));
    B.loft(cuff, (_p, k) => ({ slot: SLOT_SHOE, mat: M_LEATHER, skin: k === 0 ? two(ft, shin, 0.3) : one(shin) }), false, false);
  }
  if (mode === "sandal" && !LOW) {
    // The sole, a finger thick and a little proud of the foot all round.
    const side: [number, number][] = [[HEEL_Z - 0.01, 0.024], [HEEL_Z + 0.03, 0.04], [ANKLE[2] + 0.09, 0.042], [BALL_Z, 0.056], [TOE_Z + 0.012, 0.034]];
    const outline: V3[] = [...side.map(([z, w]): V3 => [x + w, 0, z]), ...side.slice().reverse().map(([z, w]): V3 => [x - w, 0, z])];
    const top = outline.map((p): V3 => [p[0], 0.022, p[2]]);
    B.loft([top, outline], (p) => ({
      slot: SLOT_FIXED, mat: M_LEATHER, c: [0.13, 0.08, 0.05], mask: 2,
      skin: p[2] < ANKLE[2] + 0.06 ? one(ft) : p[2] < BALL_Z ? two(ft, toe, 0.3) : one(toe),
    }), true, false);
  }
}

/** Garment rows: y, half width, front, back, centre z. */
type Row = [number, number, number, number, number];

const TUNIC: Row[] = [
  [1.47, 0.062, 0.056, 0.06, -0.014],
  // The shoulders slope from the neck to the arm.
  [1.452, 0.115, 0.064, 0.068, -0.016],
  [1.432, 0.17, 0.08, 0.084, -0.019],
  [1.39, 0.205, 0.1, 0.094, -0.02],
  [1.25, 0.186, 0.124, 0.102, -0.015],
  // Bloused over the belt (the kolpos), drawn in at it.
  [1.09, 0.172, 0.122, 0.106, -0.008],
  [1.045, 0.152, 0.104, 0.096, -0.005],
  [0.93, 0.176, 0.118, 0.12, 0],
  [0.75, 0.204, 0.138, 0.138, 0],
  // Above the knee, as working men wore it: the shins and calves bare.
  [0.6, 0.22, 0.152, 0.148, 0.004],
];

const STOLA: Row[] = [
  [1.47, 0.058, 0.052, 0.056, -0.014],
  [1.452, 0.1, 0.06, 0.064, -0.016],
  [1.43, 0.155, 0.075, 0.08, -0.018],
  [1.385, 0.178, 0.1, 0.088, -0.018],
  [1.29, 0.17, 0.124, 0.092, -0.014],
  // Girdled high, under the breast.
  [1.205, 0.148, 0.104, 0.088, -0.01],
  [1.06, 0.158, 0.108, 0.098, -0.004],
  [0.92, 0.19, 0.125, 0.13, 0],
  [0.55, 0.205, 0.145, 0.148, 0.006],
  // To the ankles, the feet showing under the hem.
  [0.15, 0.23, 0.165, 0.16, 0.014],
];

const TOGA: Row[] = [
  [1.47, 0.064, 0.058, 0.062, -0.014],
  [1.452, 0.12, 0.07, 0.074, -0.016],
  [1.43, 0.185, 0.092, 0.092, -0.019],
  [1.385, 0.222, 0.118, 0.1, -0.02],
  [1.24, 0.21, 0.14, 0.112, -0.014],
  [1.05, 0.2, 0.14, 0.125, -0.004],
  [0.8, 0.215, 0.15, 0.15, 0],
  [0.5, 0.23, 0.164, 0.16, 0.006],
  [0.24, 0.245, 0.175, 0.168, 0.01],
  [0.14, 0.248, 0.178, 0.17, 0.014],
];

function garment(B: Builder, rows: Row[], k: number, folds: number, pick: (p: V3, j: number, m: number) => { slot: number; mat: number }): void {
  const m = LOW ? 8 : 12;
  // The middle level drops the rows that only shape the shoulders and the hips.
  if (LOW) rows = rows.filter((_, i) => i !== 1 && i !== 4 && i !== 7);
  const rings = rows.map(([y, hw, f, b, zc]) => flat(y, zc, hw, f, b, m, 2.1));
  const belt = rows.findIndex((r) => r[0] < 1.1);
  B.loft(rings, (p, ki, j) => {
    const below = ki > belt && belt >= 0 ? (ki - belt) / Math.max(1, rows.length - 1 - belt) : 0;
    return { ...pick(p, j, m), folds, depth: below, skin: garmentSkin(p, k) };
  }, false, false);
}

/** A band round the garment at height y (a belt or girdle) in leather or cord. */
function band(B: Builder, rows: Row[], y: number, h: number, c: RGB, mat: number): void {
  const at = (yy: number): Row => {
    for (let i = 0; i + 1 < rows.length; i++) if (rows[i][0] >= yy && rows[i + 1][0] <= yy) {
      const t = (rows[i][0] - yy) / (rows[i][0] - rows[i + 1][0]);
      return rows[i].map((v, q) => lerp(v, rows[i + 1][q], t)) as Row;
    }
    return rows[rows.length - 1];
  };
  const rs = [y + h / 2, y - h / 2].map((yy) => { const [, hw, f, b, zc] = at(yy); return flat(yy, zc, hw + 0.008, f + 0.008, b + 0.008, 12, 2.1); });
  B.loft(rs, (p) => ({ slot: SLOT_FIXED, mat, c, skin: torsoSkin(p) }), false, false);
}

/** A short sleeve, open at the end, over the top of the upper arm. */
function sleeve(B: Builder, s: number, len: number, slot: number): void {
  const sh = mir(SHOULDER, s), el = mir(ELBOW, s);
  const path: V3[] = [lerp3(sh, el, 0.06), lerp3(sh, el, len * 0.55), lerp3(sh, el, len)];
  const arm = s > 0 ? L_ARM : R_ARM;
  B.loft(along(path, [[0.07, 0.072, 0.072], [0.066, 0.068, 0.068], [0.066, 0.068, 0.068]], 8, [0, 0, 1]), (_p, k) => ({
    slot, mat: M_WOOL, folds: 4, depth: 0.5, skin: k === 0 ? two(CHEST, arm, 0.5) : one(arm),
  }), false, false);
}

/** The palla: a mantle over the shoulders and round the body, longer behind; up over the head when veiled. */
function palla(B: Builder, veil: boolean): void {
  const m = LOW ? 8 : 12;
  const rows: Row[] = [
    [1.445, 0.13, 0.078, 0.084, -0.02],
    [1.405, 0.205, 0.1, 0.102, -0.02],
    [1.32, 0.238, 0.138, 0.12, -0.015],
    [1.15, 0.242, 0.13, 0.126, -0.008],
    [1.0, 0.232, 0.134, 0.138, 0],
    [0.9, 0.222, 0.14, 0.145, 0],
  ];
  const rings = rows.map(([y, hw, f, b, zc], k) => {
    const r = flat(y, zc, hw, f, b, m, 2.1);
    // The hem dips behind: a mantle hangs lower down the back than in front.
    if (k === rows.length - 1) for (const p of r) p[1] -= 0.16 * (1 - Math.cos(Math.atan2(p[0], p[2] - zc))) / 2;
    return r;
  });
  if (veil) {
    // Up the back of the neck and over the crown, open over the face.
    const hood: Row[] = [[1.5, 0.095, 0.03, 0.1, -0.02], [1.6, 0.095, 0.02, 0.118, -0.005], [1.69, 0.085, 0.0, 0.11, -0.01]];
    const hr = hood.map(([y, hw, f, b, zc]) => flat(y, zc, hw, f, b, m, 2.1));
    rings.unshift(...hr.reverse());
  }
  B.loft(rings, (p) => {
    const wc = smooth((p[1] - 0.95) / 0.2);
    // The sides hang over the arms and go with them, so a swinging arm stays under the cloth.
    const wa = 0.6 * smooth((Math.abs(p[0]) - 0.15) / 0.07) * smooth((1.38 - p[1]) / 0.12);
    return {
      slot: SLOT_CLOTH2, mat: M_WOOL, folds: 7, depth: 0.6 * smooth((1.3 - p[1]) / 0.4),
      skin: p[1] > 1.46 ? two(CHEST, HEAD, smooth((p[1] - 1.46) / 0.12)) : { b: [PELVIS, CHEST, p[0] > 0 ? L_ARM : R_ARM], w: [(1 - wc) * (1 - wa), wc * (1 - wa), wa] },
    };
  }, veil, false);
}

/** The toga's sinus: the heavy roll of cloth from the left shoulder across the chest to the right hip and round. */
function togaRoll(B: Builder): void {
  const path: V3[] = [[0.12, 1.43, -0.1], [0.14, 1.42, 0.06], [0.05, 1.26, 0.14], [-0.08, 1.1, 0.15], [-0.18, 0.98, 0.11], [-0.215, 0.93, 0.0], [-0.17, 0.95, -0.12], [-0.02, 1.0, -0.15]];
  const prof = path.map((_, k): [number, number, number] => { const r = k === 0 || k === path.length - 1 ? 0.025 : 0.045; return [r, r * 0.8, r * 0.8]; });
  B.loft(along(path, prof, LOW ? 4 : 5, [0, 1, 0]), (p) => ({ slot: SLOT_CLOTH, mat: M_FINE, folds: 3, depth: 0.7, skin: garmentSkin(p, 0.3) }), true, true);
}

/** An amphora on the left shoulder: lying back over it, the neck forward and up in the hand. */
function amphora(B: Builder): void {
  const base: V3 = [0.2, 1.4, -0.38], top: V3 = [0.23, 1.68, 0.2];
  const ax = norm(sub(top, base)), L = len(sub(top, base));
  const prof: [number, number][] = [[0.02, 0.03], [0.2, 0.13], [0.48, 0.152], [0.7, 0.12], [0.86, 0.045], [1, 0.05]];
  const path = prof.map(([t]) => add(base, scl(ax, t * L)));
  B.loft(along(path, prof.map(([, r]) => [r, r, r] as [number, number, number]), 6, [0, 1, 0]), () => ({ slot: SLOT_FIXED, mat: M_CLAY, c: [0.6, 0.34, 0.21], skin: one(CHEST) }), true, true, [base, null]);
}

/** A wide basket of wicker carried on the head. */
function basket(B: Builder): void {
  const rows: [number, number][] = [[1.705, 0.09], [1.73, 0.17], [1.83, 0.2], [1.835, 0.19]];
  const rs = rows.filter((_, k) => !LOW || k !== 3).map(([y, r]) => flat(y, -0.01, r, r, r, LOW ? 6 : 9));
  B.loft(rs, () => ({ slot: SLOT_FIXED, mat: M_WICKER, c: [0.62, 0.48, 0.28], folds: 18, skin: one(HEAD) }), true, false);
  // The load in it: bread or fruit under a cloth, a dome.
  B.loft([flat(1.81, -0.01, 0.18, 0.18, 0.18, 9), flat(1.86, -0.01, 0.13, 0.13, 0.13, 9)], () => ({ slot: SLOT_FIXED, mat: M_WOOL, c: [0.78, 0.72, 0.6], skin: one(HEAD) }), false, true);
}

/** A pine torch in the right hand (drawn only for the torch-bearers). */
function torch(B: Builder): void {
  const wr = mir(WRIST, -1), dn = norm(sub(wr, mir(ELBOW, -1)));
  const g = add(wr, scl(dn, 0.07));
  // Rest pose: the arm hangs, so the torch points down the arm; the raised pose turns it up.
  const path: V3[] = [add(g, scl(dn, 0.12)), add(g, scl(dn, -0.38))];
  B.loft(along(path, [[0.016, 0.016, 0.016], [0.022, 0.022, 0.022]], 5, [0, 0, 1]), () => ({ slot: SLOT_FIXED, mat: M_WOOD, c: [0.25, 0.16, 0.09], skin: one(R_HAND), mask: 1 }), false, true);
}

/** The faun's torso, nude: chest, belly and the buttocks down to the crotch. */
function nudeTorso(B: Builder): void {
  const rows: Row[] = [
    [1.46, 0.056, 0.05, 0.055, -0.014],
    [1.43, 0.12, 0.062, 0.07, -0.02],
    [1.39, 0.185, 0.08, 0.08, -0.022],
    [1.32, 0.17, 0.105, 0.088, -0.02],
    [1.24, 0.155, 0.112, 0.092, -0.014],
    [1.13, 0.138, 0.098, 0.09, -0.008],
    [1.03, 0.132, 0.09, 0.085, -0.004],
    [0.94, 0.15, 0.088, 0.1, -0.004],
    [0.86, 0.155, 0.082, 0.112, -0.01],
    [0.8, 0.12, 0.06, 0.08, -0.01],
  ];
  B.loft(rows.map(([y, hw, f, b, zc]) => flat(y, zc, hw, f, b, 12, 2.2)), (p) => ({ slot: SLOT_SKIN, mat: M_SKIN, skin: p[1] < 0.95 ? one(PELVIS) : torsoSkin(p) }), false, true);
  // The tail: a little goat's tail at the base of the spine, turned up.
  const path: V3[] = [[0, 0.93, -0.085], [0, 0.94, -0.13], [0, 0.98, -0.16], [0, 1.02, -0.165]];
  B.loft(along(path, [[0.018, 0.018, 0.018], [0.016, 0.016, 0.016], [0.011, 0.011, 0.011], [0.004, 0.004, 0.004]], 5, [0, 1, 0]), () => ({ slot: SLOT_SKIN, mat: M_SKIN, skin: one(PELVIS) }), false, true);
}

/** A figure at the near level of detail. */
/**
 * A figure at the near level of detail, or (mid) the middle one for 12 to
 * 45 m: the same dress and limbs with fewer sides and rings, no neck,
 * sleeves, belt, sole or torch, about 300 to 420 triangles.
 */
export function buildFolk(o: FolkOpts, mid = false): FolkMesh {
  LOW = mid;
  try {
    const B = new Builder();
    if (mid) midHead(B, o); else { head(B, o); neck(B); }
    const cloth = (slot: number, mat: number) => () => ({ slot, mat });
    if (o.dress === "tunic") {
      garment(B, TUNIC, 0.62, 9, cloth(SLOT_CLOTH, M_WOOL));
      if (!mid) band(B, TUNIC, 1.05, 0.035, [0.22, 0.14, 0.08], M_LEATHER);
      for (const s of [1, -1]) { if (!mid) sleeve(B, s, 0.42, SLOT_CLOTH); arm(B, s, 0.3); leg(B, s, 0.7); foot(B, s, "sandal"); }
    } else if (o.dress === "stola") {
      garment(B, STOLA, 0.5, 11, cloth(SLOT_CLOTH, M_WOOL));
      palla(B, !!o.veil);
      for (const s of [1, -1]) { arm(B, s, 0.25); leg(B, s, 0.4); foot(B, s, "sandal"); }
    } else if (o.dress === "toga") {
      // The right shoulder and chest show the tunic; the toga goes under that arm.
      garment(B, TOGA, 0.45, 10, (p) => (p[0] < -0.07 && p[1] > 1.18 && p[2] > -0.06 ? { slot: SLOT_CLOTH2, mat: M_WOOL } : { slot: SLOT_CLOTH, mat: M_FINE }));
      togaRoll(B);
      if (!mid) sleeve(B, -1, 0.42, SLOT_CLOTH2);
      arm(B, -1, 0.3);
      // The left arm wrapped in the toga to the wrist.
      arm(B, 1, 0.0, SLOT_CLOTH, M_FINE, 0.03);
      for (const s of [1, -1]) { leg(B, s, 0.3); foot(B, s, "calceus"); }
    } else {
      nudeTorso(B);
      for (const s of [1, -1]) { arm(B, s, 0.0); leg(B, s, 0.93); foot(B, s, "bare"); }
    }
    if (o.load === "amphora") amphora(B);
    if (o.load === "basket") basket(B);
    if (!mid && (o.dress === "tunic" || o.dress === "stola")) torch(B);
    return B.finish();
  } finally {
    LOW = false;
  }
}

/** The middle level's head: six sides, the hair on the crown and down the back. */
function midHead(B: Builder, o: FolkOpts): void {
  const rows = [0, 2, 4, 7].map((k) => HEAD_ROWS[k]);
  const woman = o.dress === "stola";
  B.loft(rows.map(([y, hw, f, b, zc]) => flat(y, zc, hw * 1.03, f, b, 6, 2.2)), (p, _k, j) => {
    const back = Math.min(j / 6, 1 - j / 6) * 2;
    const hair = p[1] > (woman ? 1.64 : 1.65) || (p[1] > 1.57 && back > 0.5);
    return { slot: hair ? SLOT_HAIR : SLOT_SKIN, mat: hair ? M_HAIR : M_SKIN, folds: hair ? 0 : 1, skin: one(HEAD) };
  }, true, true);
}

/**
 * The far level of detail, under 80 triangles: a four-sided body that a
 * long garment drops to the ankles (FLAG_LONG), a head, and limbs of three sides.
 */
export function buildFolkFar(): FolkMesh {
  const B = new Builder();
  const m = 4;
  const sq = (y: number, hw: number, d: number, zc = 0): V3[] => flat(y, zc, hw, d, d, m, 2);
  // Shoulders up to a point at the neck, waist, hem: the hem above the knee,
  // or at the ankle for a long garment.
  const rings = [sq(1.38, 0.2, 0.1, -0.02), sq(1.05, 0.16, 0.11), sq(0.6, 0.215, 0.15)];
  B.loft(rings, (p, k) => ({ slot: SLOT_CLOTH, mat: M_WOOL, skin: k === 2 ? skirtSkin(p, 0.5) : torsoSkin(p), drop: k === 2 ? 0.47 : 0 }), true, false, [[0, 1.47, -0.015], null]);
  // The head as a double pyramid, hair on the crown.
  {
    const eq = flat(1.6, 0.005, 0.078, 0.1, 0.1, 3, 2);
    B.loft([eq], () => ({ slot: SLOT_HAIR, mat: M_HAIR, skin: one(HEAD) }), true, false, [[0, 1.71, -0.01], null]);
    B.loft([eq], () => ({ slot: SLOT_SKIN, mat: M_SKIN, skin: one(HEAD) }), true, false, [[0, 1.46, 0.03], null]);
  }
  for (const s of [1, -1]) {
    const th = s > 0 ? L_THIGH : R_THIGH, sh = s > 0 ? L_SHIN : R_SHIN, ft = s > 0 ? L_FOOT : R_FOOT;
    // Thigh, knee, ankle, and the foot as a wedge forward to the toes in leather.
    const hp = mir(HIP, s), kn = mir(KNEE, s), an = mir(ANKLE, s);
    B.loft(along([lerp3(hp, kn, 0.4), kn, [an[0], 0.06, an[2]]], [[0.065, 0.065, 0.065], [0.05, 0.05, 0.05], [0.04, 0.045, 0.06]], 3, [0, 0, 1]), (_p, k) => ({
      slot: k === 2 ? SLOT_FIXED : SLOT_SKIN, mat: k === 2 ? M_LEATHER : M_SKIN, c: k === 2 ? [0.22, 0.14, 0.08] : [1, 1, 1],
      skin: k === 0 ? one(th) : k === 1 ? two(th, sh, 0.5) : one(ft),
    }), false, true, [null, [an[0], 0.01, TOE_Z]]);
    const arm = s > 0 ? L_ARM : R_ARM, fore = s > 0 ? L_FORE : R_FORE;
    const sp = mir(SHOULDER, s), wr = mir(WRIST, s), tip = add(wr, [0, -0.13, 0.01]);
    B.loft(along([sp, wr], [[0.055, 0.055, 0.055], [0.035, 0.035, 0.035]], 3, [0, 0, 1]), (_p, k) => ({
      slot: k === 0 ? SLOT_CLOTH : SLOT_SKIN, mat: M_SKIN, skin: k === 0 ? two(CHEST, arm, 0.7) : one(fore),
    }), false, true, [null, tip]);
  }
  return B.finish();
}

// --- the Dancing Faun -------------------------------------------------------------

/** The bronze's pose (Naples, MANN 5002): up on the balls of both feet, arms up and out, head back. */
export function faunPose(): PoseSpec {
  const lp = -0.75, rp = -0.62;
  return {
    hip: [0.03, -0.035, -0.01],
    pelvis: [0.18, -0.04, 0.05],
    chest: [-0.28, -0.12, -0.06],
    head: [-0.35, -0.45, -0.12],
    feet: [
      { ankle: ankleFrom([0.19, 0, 0.12 + BALL_Z - HEEL_Z], BALL_Z, lp, 1), pitch: lp },
      { ankle: ankleFrom([-0.1, 0, -0.12 + BALL_Z - HEEL_Z], BALL_Z, rp, -1), pitch: rp },
    ],
    // The right hand high over the head, the left out level with the shoulder and forward.
    wrists: [[0.6, 1.5, 0.18], [-0.36, 1.87, 0.05]],
    poles: [[0.2, -1, -0.6], [-1, -0.3, -0.4]],
    handBend: [0.5, 0.4],
  };
}

/**
 * The lampbearer (the bronze youth of the Casa di Giulio Polibio, life
 * size): weight on the right leg, the left foot drawn back, the left hand
 * up and forward under the lamp tray at `tray` (figure frame, scale 1).
 */
export function lampbearerPose(tray: V3): PoseSpec {
  const right: FootPose = { ankle: ankleFrom([-0.08, 0, 0.0], HEEL_Z, 0, -1), pitch: 0 };
  const lp = -0.22;
  const left: FootPose = { ankle: ankleFrom([0.13, 0, -0.1 + BALL_Z - HEEL_Z], BALL_Z, lp, 1), pitch: lp };
  const pelvis: [number, number, number] = [0.08, 0.0, -0.06];
  const dx = -0.03;
  return {
    hip: [dx, hipLift(pelvis, dx, [left, right], -0.008) - 0.004, 0], pelvis,
    chest: [-0.1, 0.02, 0.07], head: [0.3, 0.12, 0.04],
    feet: [left, right],
    wrists: [[tray[0] - 0.02, tray[1] - 0.09, tray[2] - 0.03], armAt(-1, 0.05, 0.06, 0.2)],
    poles: [[1, -0.8, -0.3], BACK_POLE(-1)],
    handBend: [-0.9, 0],
  };
}

/** A nude figure (the faun, the lampbearer) with a pose applied: positions and normals in the figure's frame. */
export function posedStatue(o: FolkOpts, spec: PoseSpec): { position: Float32Array; normal: Float32Array; index: Uint16Array; colour: Uint8Array } {
  const mesh = buildFolk(o);
  const bones = solvePose(spec);
  const n = mesh.position.length / 3;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p: V3 = [mesh.position[i * 3], mesh.position[i * 3 + 1], mesh.position[i * 3 + 2]];
    const nv: V3 = [mesh.normal[i * 4] / 127, mesh.normal[i * 4 + 1] / 127, mesh.normal[i * 4 + 2] / 127];
    let P: V3 = [0, 0, 0], N: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const w = mesh.weight[i * 4 + k] / 255;
      if (w <= 0) continue;
      const m = Array.from(bones.subarray(mesh.skin[i * 4 + k] * 16, mesh.skin[i * 4 + k] * 16 + 16));
      P = add(P, scl(apply(m, p), w));
      N = add(N, scl(applyDir(m, nv), w));
    }
    N = norm(N);
    pos.set(P, i * 3); nrm.set(N, i * 3);
  }
  return { position: pos, normal: nrm, index: mesh.index, colour: mesh.colour };
}

export const posedFaun = (): ReturnType<typeof posedStatue> => posedStatue({ dress: "nude", faun: true }, faunPose());

/** Skinned positions of a mesh in a pose (the gate measures with it). */
export function skinned(mesh: FolkMesh, bones: Float32Array): Float32Array {
  const n = mesh.position.length / 3, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p: V3 = [mesh.position[i * 3], mesh.position[i * 3 + 1], mesh.position[i * 3 + 2]];
    let P: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const w = mesh.weight[i * 4 + k] / 255;
      if (w > 0) P = add(P, scl(apply(Array.from(bones.subarray(mesh.skin[i * 4 + k] * 16, mesh.skin[i * 4 + k] * 16 + 16)), p), w));
    }
    out.set(P, i * 3);
  }
  return out;
}
