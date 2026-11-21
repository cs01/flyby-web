// Pompeii's statues, sculpted: the townsfolk's skeleton (render/folk.ts)
// posed into the real statue types, its body and drapery written as a
// signed distance field (rounded cones and ellipsoids blended smoothly, folds
// as displacements of the cloth) and polygonised by surface nets. The head,
// hands and feet are meshed again on a finer grid than the body, so a face,
// fingers and toes read at arm's length. Bronze takes a patina from the
// field itself (green where it is hollow, worn bright where it is thin and
// exposed); marble is painted, as Roman marble was: hair, eyes, lips, the
// borders and cloaks of the clothes.
//
// Pure (no THREE): written into the town's vertex store, as the Faun was.

import { FOLK_REST, ankleFrom, armAt, hipLift, solvePose, type FootPose, type PoseSpec, type V3 } from "./folk";
import { buildHorse, poseHorse, HORSE_BONES } from "./horse";
import type { Sink } from "./pompeiiorders";

type RGB = [number, number, number];
const { PELVIS_PIVOT, HIP, KNEE, ANKLE, SHOULDER, ELBOW, WRIST, HEEL_Z, BALL_Z, TOE_Z } = FOLK_REST;
void PELVIS_PIVOT;

/** Surface styles: the town shader's bronze, and statue marble (no branch of its own: plain lit, painted by vertex colour). */
export const STYLE_BRONZE = 17, STYLE_STATUE_MARBLE = 24;

// Bones, as render/folk.ts numbers them.
const PELVIS = 0, CHEST = 1, HEAD = 2, L_THIGH = 3, L_SHIN = 4, L_FOOT = 5, R_THIGH = 6, R_SHIN = 7, R_FOOT = 8;
const L_ARM = 9, L_FORE = 10, L_HAND = 11, R_ARM = 12, R_FORE = 13, R_HAND = 14, L_TOE = 15, R_TOE = 16;
/** A primitive placed in world (posed) space rather than on a bone. */
const WORLD = -1;

/** What a surface is, for its colour. */
const enum Lab { Skin, Hair, Cloth, Border, Eye, Lip, Metal, Cloak, Leather, Wood }
/** Which mesh a primitive is part of: the body at the coarse grid, the rest on finer ones. */
const enum Reg { Body = 1, Head = 2, HandL = 4, HandR = 8, FootL = 16, FootR = 32, Prop = 64 }

type F = (x: number, y: number, z: number) => number;
interface Prim { bone: number; f: F; c: V3; r: number; k: number; lab: Lab; reg: number; sub?: boolean; tube?: [V3, V3, number, number] }

const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mir = (p: V3, s: number): V3 => [p[0] * s, p[1], p[2]];
const smooth = (a: number, b: number, t: number): number => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };

// --- distance primitives (Inigo Quilez's forms) -------------------------------------

function ellipsoid(c: V3, r: V3): F {
  return (x, y, z) => {
    const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
    const k0 = len3(px, py, pz), k1 = len3(px / r[0], py / r[1], pz / r[2]);
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(r[0], r[1], r[2]);
  };
}
function sphere(c: V3, r: number): F { return (x, y, z) => len3(x - c[0], y - c[1], z - c[2]) - r; }
/** A cone between two spheres. */
function cone(a: V3, b: V3, r1: number, r2: number): F {
  const ba = sub(b, a), l2 = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2], rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - a[0], pay = y - a[1], paz = z - a[2];
    const yy = pax * ba[0] + pay * ba[1] + paz * ba[2], zz = yy - l2;
    const qx = pax * l2 - ba[0] * yy, qy = pay * l2 - ba[1] * yy, qz = paz * l2 - ba[2] * yy;
    const x2 = qx * qx + qy * qy + qz * qz, y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}
const smin = (a: number, b: number, k: number): number => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a: number, b: number, k: number): number => -smin(-a, -b, k);

/** Bounding sphere radius of a primitive about its centre. */
const P = (bone: number, f: F, c: V3, r: number, lab: Lab, reg: number, k = 0.02, isSub = false): Prim => ({ bone, f, c, r, k, lab, reg, sub: isSub });
const E = (bone: number, c: V3, r: V3, lab: Lab, reg: number, k = 0.02): Prim => P(bone, ellipsoid(c, r), c, Math.max(...r), lab, reg, k);
const C = (bone: number, a: V3, b: V3, r1: number, r2: number, lab: Lab, reg: number, k = 0.02): Prim =>
  ({ ...P(bone, cone(a, b, r1, r2), lerp3(a, b, 0.5), len3(...sub(b, a)) / 2 + Math.max(r1, r2), lab, reg, k), tube: [a, b, r1, r2] });
/** A chain of cones through points. */
const chain = (bone: number, pts: V3[], r: number[], lab: Lab, reg: number, k = 0.02): Prim[] =>
  pts.slice(1).map((p, i) => C(bone, pts[i], p, r[i], r[i + 1], lab, reg, k));

// --- the body ------------------------------------------------------------------------

export interface Build {
  /** Muscle and girth, 1 an athletic man. */
  mass: number;
  woman?: boolean;
  faun?: boolean;
  hair: "short" | "curls" | "knot" | "veil";
  /** Ears and features exaggerated into the Faun's. */
}

/** A nude body round the rest skeleton (render/folk.ts), each part on its bone. */
function bodyPrims(b: Build): Prim[] {
  const m = b.mass, w = !!b.woman;
  const out: Prim[] = [];
  const BH = Reg.Body;
  // Pelvis and hips.
  out.push(E(PELVIS, [0, 0.93, -0.005], [(w ? 0.165 : 0.15) * m, 0.11, 0.1 * m], Lab.Skin, BH, 0.04));
  out.push(E(PELVIS, [0, 0.99, 0.03], [0.12 * m, 0.09, 0.08 * m], Lab.Skin, BH, 0.04));
  if (!w) out.push(E(PELVIS, [0, 0.81, 0.07], [0.028, 0.038, 0.03], Lab.Skin, BH, 0.02));
  // Chest, belly, back.
  out.push(E(CHEST, [0, 1.2, -0.005], [0.142 * m, 0.17, 0.1 * m], Lab.Skin, BH, 0.04));
  out.push(E(CHEST, [0, 1.08, 0.03], [0.112 * m, 0.11, 0.078 * m], Lab.Skin, BH, 0.04));
  out.push(E(CHEST, [0, 1.25, -0.05], [0.15 * m, 0.15, 0.065 * m], Lab.Skin, BH, 0.04));
  out.push(C(CHEST, [0, 1.36, -0.02], [0, 1.52, 0.0], 0.052 * m, 0.046 * m, Lab.Skin, BH | Reg.Head, 0.03));
  for (const s of [1, -1]) {
    if (w) out.push(E(CHEST, [0.068 * s, 1.25, 0.075], [0.058, 0.058, 0.05], Lab.Skin, BH, 0.03));
    else out.push(E(CHEST, [0.07 * s, 1.28, 0.06], [0.075 * m, 0.052, 0.045 * m], Lab.Skin, BH, 0.03));
    out.push(E(CHEST, [0.105 * s, 1.03, 0.0], [0.05 * m, 0.08, 0.07 * m], Lab.Skin, BH, 0.04));
    out.push(C(CHEST, [0.16 * s, 1.4, -0.03], [0.03 * s, 1.445, -0.03], 0.042 * m, 0.048 * m, Lab.Skin, BH, 0.04));
    out.push(E(PELVIS, [0.068 * s, 0.86, -0.055], [0.084 * m, 0.1, 0.074 * m], Lab.Skin, BH, 0.03));
    // Arm: deltoid, upper arm with biceps and triceps, forearm.
    const arm = s > 0 ? L_ARM : R_ARM, fore = s > 0 ? L_FORE : R_FORE, hand = s > 0 ? L_HAND : R_HAND;
    const sh = mir(SHOULDER, s), el = mir(ELBOW, s), wr = mir(WRIST, s);
    out.push(E(arm, [0.185 * s, 1.355, -0.02], [0.056 * m, 0.075, 0.058 * m], Lab.Skin, BH, 0.03));
    out.push(C(arm, sh, el, 0.044 * m, 0.035 * m, Lab.Skin, BH, 0.025));
    out.push(E(arm, add(lerp3(sh, el, 0.45), [0, 0, 0.018]), [0.034 * m, 0.075, 0.033 * m], Lab.Skin, BH, 0.025));
    out.push(E(arm, add(lerp3(sh, el, 0.4), [0, 0, -0.02]), [0.032 * m, 0.08, 0.032 * m], Lab.Skin, BH, 0.025));
    out.push(C(fore, el, wr, 0.038 * m, 0.024, Lab.Skin, BH, 0.025));
    // The wrist again in the hand's own finer mesh, so the hand grows out of it.
    out.push(C(fore, lerp3(el, wr, 0.82), wr, 0.027, 0.024, Lab.Skin, s > 0 ? Reg.HandL : Reg.HandR, 0.015));
    out.push(E(fore, add(lerp3(el, wr, 0.25), [0.005 * s, 0, 0.01]), [0.036 * m, 0.07, 0.033 * m], Lab.Skin, BH, 0.025));
    out.push(...handPrims(s, hand));
    // Leg: thigh with quadriceps and hamstrings, knee, shin with calf, foot.
    const th = s > 0 ? L_THIGH : R_THIGH, shin = s > 0 ? L_SHIN : R_SHIN;
    const hp = mir(HIP, s), kn = mir(KNEE, s), an = mir(ANKLE, s);
    out.push(C(th, hp, kn, 0.08 * m, 0.048 * m, Lab.Skin, BH, 0.04));
    out.push(E(th, add(lerp3(hp, kn, 0.5), [-0.006 * s, 0, 0.03]), [0.064 * m, 0.16, 0.058 * m], Lab.Skin, BH, 0.04));
    out.push(E(th, add(lerp3(hp, kn, 0.42), [0, 0, -0.03]), [0.058 * m, 0.15, 0.052 * m], Lab.Skin, BH, 0.03));
    out.push(E(shin, add(kn, [0, -0.01, 0.032]), [0.028, 0.032, 0.02], Lab.Skin, BH, 0.02));
    out.push(C(shin, kn, an, 0.046 * m, 0.028, Lab.Skin, BH, 0.03));
    out.push(C(shin, lerp3(kn, an, 0.8), an, 0.032, 0.028, Lab.Skin, s > 0 ? Reg.FootL : Reg.FootR, 0.02));
    out.push(E(shin, add(lerp3(kn, an, 0.3), [0.004 * s, 0, -0.03]), [0.044 * m, 0.1, 0.043 * m], Lab.Skin, BH, 0.03));
    out.push(...footPrims(s));
  }
  out.push(...headPrims(b));
  if (b.faun) out.push(...chain(PELVIS, [[0, 0.93, -0.085], [0, 0.95, -0.13], [0, 1.0, -0.16], [0, 1.04, -0.15]], [0.016, 0.014, 0.01, 0.004], Lab.Hair, BH, 0.015));
  return out;
}

/** Palm, four fingers a little curled, the thumb forward. */
function handPrims(s: number, bone: number): Prim[] {
  const reg = s > 0 ? Reg.HandL : Reg.HandR;
  const wr = mir(WRIST, s), dn: V3 = [0.04 * s, -0.99, 0.12];
  const at = (d: number, inward: number, fwd: number): V3 => add(wr, add(scl(dn, d), [-s * inward, 0, fwd]));
  const out: Prim[] = [E(bone, at(0.05, 0, 0.004), [0.018, 0.052, 0.043], Lab.Skin, reg, 0.012)];
  [0.028, 0.009, -0.01, -0.027].forEach((z, i) => {
    const L = [0.078, 0.088, 0.083, 0.066][i], r = [0.0088, 0.009, 0.0086, 0.0076][i];
    const k1 = at(0.095, 0.002, z), k2 = at(0.095 + L * 0.55, 0.008, z * 1.05), k3 = at(0.095 + L, 0.022, z * 1.08);
    out.push(...chain(bone, [k1, k2, k3], [r, r * 0.92, r * 0.8], Lab.Skin, reg, 0.006));
  });
  out.push(...chain(bone, [at(0.025, 0.004, 0.035), at(0.06, 0.014, 0.05), at(0.09, 0.026, 0.05)], [0.012, 0.0095, 0.008], Lab.Skin, reg, 0.008));
  return out;
}

/** Heel, arch and ball, the toes on their own bone, flat on the sole. */
function footPrims(s: number): Prim[] {
  const reg = s > 0 ? Reg.FootL : Reg.FootR, ft = s > 0 ? L_FOOT : R_FOOT, toe = s > 0 ? L_TOE : R_TOE;
  const x = ANKLE[0] * s;
  const sole = (f: F): F => (px, py, pz) => Math.max(f(px, py, pz), -py);
  const out: Prim[] = [
    P(ft, sole(sphere([x, 0.036, HEEL_Z + 0.03], 0.034)), [x, 0.036, HEEL_Z + 0.03], 0.04, Lab.Skin, reg, 0.02),
    P(ft, sole(ellipsoid([x + 0.004 * s, 0.03, ANKLE[2] + 0.085], [0.04, 0.034, 0.1])), [x, 0.03, ANKLE[2] + 0.085], 0.1, Lab.Skin, reg, 0.025),
    E(ft, [x + 0.016 * s, ANKLE[1], ANKLE[2]], [0.014, 0.018, 0.016], Lab.Skin, reg, 0.012),
    E(ft, [x - 0.016 * s, ANKLE[1] + 0.005, ANKLE[2] - 0.005], [0.014, 0.018, 0.016], Lab.Skin, reg, 0.012),
  ];
  // The toes: the big toe inside, four smaller ones out toward the edge.
  [[-0.026, 0.013, 0.07], [-0.008, 0.0095, 0.064], [0.007, 0.009, 0.058], [0.02, 0.0085, 0.05], [0.031, 0.008, 0.042]].forEach(([dx, r, L]) => {
    const a: V3 = [x + dx * s, 0.016, BALL_Z - 0.01], b: V3 = [x + dx * 1.1 * s, r + 0.002, BALL_Z - 0.01 + L];
    out.push(P(toe, sole(cone(a, b, r * 1.15, r)), lerp3(a, b, 0.5), L, Lab.Skin, reg, 0.006));
  });
  void TOE_Z;
  return out;
}

/** The head: skull, face with brow, nose, lips, chin and cheekbones, eyes in their sockets, ears, hair. */
function headPrims(b: Build): Prim[] {
  const R = Reg.Head, H = HEAD;
  const out: Prim[] = [
    E(H, [0, 1.605, -0.01], [0.073, 0.087, 0.097], Lab.Skin, R, 0.03),
    E(H, [0, 1.558, 0.034], [0.06, 0.078, 0.066], Lab.Skin, R, 0.03),
    C(H, [0, 1.52, 0.045], [0, 1.481, b.woman ? 0.07 : 0.074], 0.044, b.woman ? 0.018 : 0.021, Lab.Skin, R, 0.025),
    C(H, [-0.045, 1.609, 0.078], [0.045, 1.609, 0.078], b.faun ? 0.014 : 0.0115, b.faun ? 0.014 : 0.0115, Lab.Skin, R, 0.018),
    C(H, [0, 1.604, 0.089], [0, 1.561, b.faun ? 0.108 : 0.113], 0.008, b.faun ? 0.014 : 0.011, Lab.Skin, R, 0.01),
    E(H, [0, 1.556, 0.1], [0.017, 0.009, 0.011], Lab.Skin, R, 0.008),
    E(H, [0, 1.523, 0.093], [0.021, 0.0065, 0.009], Lab.Lip, R, 0.007),
    E(H, [0, 1.509, 0.09], [0.018, 0.007, 0.0095], Lab.Lip, R, 0.007),
    P(H, ellipsoid([0, 1.516, 0.1], [0.019, 0.001, 0.008]), [0, 1.516, 0.1], 0.02, Lab.Lip, R, 0.003, true),
  ];
  for (const s of [1, -1]) {
    out.push(C(H, [0.058 * s, 1.548, 0.0], [0.028 * s, 1.49, 0.058], 0.018, 0.015, Lab.Skin, R, 0.02));
    out.push(E(H, [0.044 * s, 1.574, 0.064], [0.021, 0.015, 0.02], Lab.Skin, R, 0.015));
    out.push(P(H, sphere([0.032 * s, 1.592, 0.093], 0.0165), [0.032 * s, 1.592, 0.093], 0.017, Lab.Skin, R, 0.01, true));
    out.push(P(H, sphere([0.032 * s, 1.591, 0.081], 0.0125), [0.032 * s, 1.591, 0.081], 0.013, Lab.Eye, R, 0.004));
    // Upper lids over the eyes.
    out.push(E(H, [0.032 * s, 1.599, 0.087], [0.016, 0.006, 0.01], Lab.Skin, R, 0.005));
    if (b.faun) out.push(C(H, [0.074 * s, 1.58, -0.012], [0.094 * s, 1.64, -0.035], 0.012, 0.003, Lab.Skin, R, 0.01));
    else out.push(E(H, [0.074 * s, 1.585, -0.012], [0.01, 0.03, 0.02], Lab.Skin, R, 0.01));
    if (b.faun) out.push(C(H, [0.028 * s, 1.66, 0.062], [0.046 * s, 1.715, 0.035], 0.009, 0.002, Lab.Hair, R, 0.008));
  }
  // Hair: a shell over the skull above the hairline, in curls or locks.
  const hairline = (y: number, z: number): number => 1.52 + (b.woman ? 0.11 : 0.125) * smooth(-0.06, 0.08, z) - y;
  const curl = b.hair === "curls" ? 0.0065 : 0.0035;
  const cap = ellipsoid([0, 1.625, -0.018], [0.082, 0.087, 0.104]);
  out.push(P(H, (x, y, z) => Math.max(cap(x, y, z) - curl * Math.sin(x * 140) * Math.sin(y * 150 + 1.3) * Math.sin(z * 130 + 0.7), hairline(y, z)), [0, 1.62, -0.02], 0.11, Lab.Hair, R, 0.008));
  if (b.hair === "knot") {
    // Apollo's and Diana's knot on the crown, a lock down each side of the neck.
    out.push(E(H, [0, 1.705, 0.005], [0.033, 0.024, 0.03], Lab.Hair, R, 0.012));
    for (const s of [1, -1]) out.push(...chain(H, [[0.062 * s, 1.56, -0.03], [0.07 * s, 1.49, -0.02], [0.074 * s, 1.43, -0.005]], [0.014, 0.012, 0.008], Lab.Hair, R | Reg.Body, 0.01));
  }
  if (b.woman) out.push(E(H, [0, 1.6, -0.1], [0.04, 0.035, 0.035], Lab.Hair, R, 0.015));
  return out;
}

// --- dress ---------------------------------------------------------------------------

/** Vertical folds round a body of cloth: depth grows toward the hem. */
const foldsAt = (x: number, y: number, z: number, top: number, n: number, depth: number): number => {
  const th = Math.atan2(x, z), t = smooth(top, top - 0.5, y);
  return depth * t * (0.6 * Math.sin(n * th + 4 * y) + 0.4 * Math.sin(n * 0.57 * th - 7 * y + 1.3));
};

/** A skirt of cloth on the pelvis from `top` to a hem at `hem` (front) and `hemBack`, flaring. */
function skirt(top: number, rTop: number, rHem: number, hem: number, hemBack: number, n: number, depth: number, lab: Lab): Prim {
  const f: F = (x, y, z) => {
    const t = Math.max(0, Math.min(1, (top - y) / (top - hem)));
    const r = rTop + (rHem - rTop) * Math.sqrt(t);
    const d = Math.hypot(x, (z - 0.01) / 0.8) * 0.85 - r * 0.85 - foldsAt(x, y, z, top, n, depth);
    const th = Math.atan2(x, z);
    const hy = hem + (hemBack - hem) * (1 - Math.cos(th)) / 2;
    return Math.max(d, y - top, hy - y);
  };
  return P(PELVIS, f, [0, (top + hem) / 2, 0], (top - hem) / 2 + rHem + 0.05, lab, Reg.Body, 0.03);
}

/**
 * The toga (the praetexta of a magistrate): the long skirt to the ankles,
 * the wrap over the left shoulder with folds running down from it, the
 * balteus across the chest, the sinus hanging in a deep curve in front, the
 * umbo pulled out at the waist, the left arm wrapped.
 */
function togaPrims(): Prim[] {
  const B = Reg.Body;
  const out: Prim[] = [skirt(1.0, 0.2, 0.25, 0.13, 0.06, 15, 0.013, Lab.Cloth)];
  // The wrap: folds run down diagonally from the left shoulder to the right hip.
  const wrap = ellipsoid([0, 1.21, -0.002], [0.178, 0.215, 0.135]);
  const d2: V3 = [0.6, -0.8, 0];
  const clip = (x: number, y: number): number => (x + 0.15) * -0.75 + (y - 1.22) * 0.66;
  out.push(P(CHEST, (x, y, z) => Math.max(wrap(x, y, z) - 0.008 * Math.sin((x * d2[0] + y * d2[1]) * 95), clip(x, y)), [0, 1.2, 0], 0.25, Lab.Cloth, B, 0.03));
  // The tunic under it, seen on the right shoulder, with its short sleeve.
  out.push(E(CHEST, [0, 1.24, -0.005], [0.158, 0.19, 0.115], Lab.Cloth, B, 0.03));
  out.push(C(R_ARM, SHOULDER.map((v, i) => (i ? v : -v)) as V3, lerp3(mir(SHOULDER, -1), mir(ELBOW, -1), 0.45), 0.062, 0.055, Lab.Cloth, B, 0.02));
  // Over the left shoulder and down the left arm.
  out.push(E(CHEST, [0.13, 1.38, -0.005], [0.1, 0.09, 0.13], Lab.Cloth, B, 0.04));
  out.push(C(L_ARM, mir(SHOULDER, 1), mir(ELBOW, 1), 0.072, 0.066, Lab.Cloth, B, 0.03));
  out.push(C(L_FORE, mir(ELBOW, 1), lerp3(mir(ELBOW, 1), mir(WRIST, 1), 0.85), 0.064, 0.05, Lab.Cloth, B, 0.03));
  // Balteus and sinus, edged in the praetexta's purple.
  out.push(...chain(CHEST, [[0.13, 1.43, 0.07], [0.02, 1.3, 0.15], [-0.1, 1.15, 0.155], [-0.19, 1.04, 0.12]], [0.03, 0.036, 0.038, 0.04], Lab.Border, B, 0.03));
  out.push(...chain(PELVIS, [[-0.2, 1.0, 0.1], [-0.15, 0.78, 0.18], [-0.03, 0.66, 0.2], [0.1, 0.72, 0.19], [0.19, 0.9, 0.14]], [0.042, 0.045, 0.045, 0.042, 0.04], Lab.Border, B, 0.035));
  out.push(E(PELVIS, [0.02, 1.04, 0.15], [0.06, 0.05, 0.045], Lab.Cloth, B, 0.03));
  return out;
}

/**
 * Armour of an officer (Holconius Rufus, the riders): a muscled cuirass with
 * its flared hem, leather strips (pteruges) over a short tunic, and the
 * paludamentum, the general's cloak, over the left shoulder and down the back.
 */
function cuirassPrims(seated: boolean): Prim[] {
  const B = Reg.Body;
  const out: Prim[] = [
    E(CHEST, [0, 1.205, 0.0], [0.158, 0.2, 0.122], Lab.Metal, B, 0.03),
    E(CHEST, [0, 0.995, 0.0], [0.17, 0.035, 0.13], Lab.Metal, B, 0.02),
  ];
  for (const s of [1, -1]) {
    out.push(E(CHEST, [0.068 * s, 1.285, 0.085], [0.07, 0.05, 0.04], Lab.Metal, B, 0.03));
    for (const y of [1.15, 1.09, 1.03]) out.push(E(CHEST, [0.036 * s, y, 0.112], [0.032, 0.024, 0.02], Lab.Metal, B, 0.015));
    out.push(C(CHEST, [0.12 * s, 1.43, 0.09], [0.12 * s, 1.44, -0.08], 0.024, 0.024, Lab.Leather, B, 0.012));
  }
  // Pteruges round the hips, over the tunic.
  for (let k = 0; k < 12; k++) {
    const th = (k / 12) * Math.PI * 2, sn = Math.sin(th), cs = Math.cos(th);
    const a: V3 = [0.16 * sn, 0.97, 0.12 * cs], b: V3 = [0.19 * sn, seated ? 0.86 : 0.79, 0.15 * cs];
    out.push(C(PELVIS, a, b, 0.02, 0.022, Lab.Leather, B, 0.006));
  }
  if (!seated) out.push(skirt(0.95, 0.17, 0.22, 0.6, 0.58, 12, 0.008, Lab.Cloth));
  // The cloak: bunched on the left shoulder, a shell down the back with folds.
  out.push(E(CHEST, [0.15, 1.42, -0.01], [0.085, 0.06, 0.12], Lab.Cloak, B, 0.03));
  const R0 = 0.2, bottom = seated ? 1.0 : 0.62;
  out.push(P(CHEST, (x, y, z) => {
    const r = Math.hypot(x, (z + 0.01) * 1.25);
    const shell = Math.abs(r - R0 - 0.01 * Math.sin(Math.atan2(x, -z) * 9 + y * 3)) - 0.011;
    return Math.max(shell, z - 0.02, y - 1.44, bottom - y);
  }, [0, (1.44 + bottom) / 2, -0.1], 0.5, Lab.Cloak, B, 0.02));
  out.push(C(L_FORE, mir(ELBOW, 1), lerp3(mir(ELBOW, 1), mir(WRIST, 1), 0.8), 0.06, 0.05, Lab.Cloak, B, 0.025));
  return out;
}

/** A belted chiton with sleeves, as Diana wears it (her bust). */
function chitonPrims(): Prim[] {
  const B = Reg.Body;
  const top = ellipsoid([0, 1.22, -0.003], [0.162, 0.21, 0.118]);
  return [
    P(CHEST, (x, y, z) => top(x, y, z) - 0.006 * Math.sin(Math.atan2(x, z) * 16 + y * 20), [0, 1.22, 0], 0.25, Lab.Cloth, B, 0.03),
    ...chain(CHEST, [[0.11, 1.43, 0.06], [-0.02, 1.3, 0.12], [-0.14, 1.15, 0.09]], [0.012, 0.012, 0.012], Lab.Leather, B, 0.008),
  ];
}

// --- poses -----------------------------------------------------------------------------

/** Contrapposto: the weight on one leg, the other foot drawn back and out. */
function stance(weightRight: boolean, out: number, back: number, lift: number): { hip: V3; pelvis: [number, number, number]; feet: [FootPose, FootPose] } {
  const s = weightRight ? 1 : -1;
  const planted: FootPose = { ankle: ankleFrom([-0.08 * s, 0, 0.0], HEEL_Z, 0, -s), pitch: 0 };
  const free: FootPose = { ankle: ankleFrom([(0.1 + out) * s, 0, -back + BALL_Z - HEEL_Z], BALL_Z, -lift, s), pitch: -lift };
  const pelvis: [number, number, number] = [0.06 * s, 0.01, -0.05 * s];
  const dx = -0.035 * s;
  const feet: [FootPose, FootPose] = weightRight ? [free, planted] : [planted, free];
  return { hip: [dx, hipLift(pelvis, dx, feet, -0.01) - 0.004, 0], pelvis, feet };
}

export type StatueKind = "togate" | "cuirassed" | "rider" | "apollo" | "diana" | "doryphoros" | "faun" | "lampbearer";

interface Design { build: Build; pose: PoseSpec; dress: (pose: Float32Array) => Prim[]; marble: boolean; bustY?: number }

function design(kind: StatueKind, tray?: V3): Design {
  switch (kind) {
    case "togate": {
      // An orator: weight on the right leg, the right arm raised in address, the left holding the toga's fold.
      const st = stance(true, 0.02, 0.08, 0.12);
      return {
        build: { mass: 1.05, hair: "short" }, marble: false,
        pose: { ...st, chest: [-0.06, 0.02, 0.03], head: [0.18, 0.04, 0.02], wrists: [armAt(1, 0.25, 0.1, 1.2), [-0.32, 1.42, 0.3]], poles: [[0.3, -0.3, -1], [-1, -0.6, -0.3]], handBend: [0.2, -0.6] },
        dress: () => togaPrims(),
      };
    }
    case "cuirassed": {
      // Holconius Rufus: cuirass and cloak, the right arm out, the left with the cloak over it.
      const st = stance(true, 0.03, 0.1, 0.15);
      return {
        build: { mass: 1.1, hair: "short" }, marble: true,
        pose: { ...st, chest: [-0.05, 0, 0.02], head: [0.2, 0.0, 0.0], wrists: [armAt(1, 0.3, 0.12, 1.3), [-0.36, 1.2, 0.3]], poles: [[0.3, -0.3, -1], [-1, -0.8, -0.2]], handBend: [0, -0.3] },
        dress: () => cuirassPrims(false),
      };
    }
    case "rider": {
      // Seated astride, the right arm stretched out in address (the Nonius Balbus type).
      const feet: [FootPose, FootPose] = [
        { ankle: [0.27, 0.42, 0.1], pitch: -0.25 },
        { ankle: [-0.27, 0.42, 0.1], pitch: -0.25 },
      ];
      return {
        build: { mass: 1.1, hair: "short" }, marble: false,
        pose: { hip: [0, 0, 0], pelvis: [0, 0, 0], feet, chest: [0, 0.02, 0], head: [0.1, 0.0, 0], wrists: [[0.22, 1.08, 0.3], [-0.3, 1.5, 0.5]], poles: [[0.3, -0.5, -1], [-1, -0.4, -0.3]], handBend: [0, -0.4] },
        dress: () => cuirassPrims(true),
      };
    }
    case "apollo": {
      // Apollo the archer, as the bronze from his sanctuary: the bow held out
      // in the left hand, the right drawn back after the shot, head turned along it.
      const st = stance(false, 0.04, 0.12, 0.25);
      return {
        build: { mass: 0.98, hair: "knot" }, marble: false,
        pose: { ...st, chest: [0.35, 0.0, -0.02], head: [0.45, -0.04, 0.03], wrists: [[0.52, 1.36, 0.36], [0.02, 1.33, 0.2]], poles: [[0.4, -1, -0.4], [-1, -0.4, -0.8]], handBend: [0, 0.4] },
        dress: (bones) => bowPrims(bones),
      };
    }
    case "diana": {
      // Diana, a bust as hers is: hair bound up, the chiton and the quiver strap.
      return {
        build: { mass: 0.9, woman: true, hair: "knot" }, marble: false, bustY: 1.1,
        pose: { hip: [0, 0, 0], pelvis: [0, 0, 0], chest: [0.1, 0, 0], head: [-0.25, 0.04, 0], feet: [{ ankle: ankleFrom([0.08, 0, 0], HEEL_Z, 0, 1), pitch: 0 }, { ankle: ankleFrom([-0.08, 0, 0], HEEL_Z, 0, -1), pitch: 0 }], wrists: [armAt(1, 0, 0.05, 0.2), armAt(-1, 0, 0.05, 0.2)], poles: [[0.3, 0, -1], [-0.3, 0, -1]] },
        dress: () => chitonPrims(),
      };
    }
    case "doryphoros": {
      // Polykleitos's spear-bearer, the marble copy from the Samnite Palaestra:
      // weight on the right leg, the left foot back on its toes, the right arm
      // hanging, the left bent forward with the spear over the shoulder.
      const st = stance(true, 0.04, 0.2, 0.55);
      return {
        build: { mass: 1.15, hair: "short" }, marble: true,
        pose: { ...st, chest: [-0.12, 0.02, 0.05], head: [0.3, 0.12, 0.02], wrists: [[0.25, 1.06, 0.22], armAt(-1, 0.02, 0.05, 0.1)], poles: [[0.3, -0.3, -1], [-0.3, 0, -1]], handBend: [0.6, 0] },
        dress: (bones) => spearPrims(bones),
      };
    }
    case "faun": {
      // The Dancing Faun turning on the balls of his feet, arms up, head back.
      const lp = -0.75, rp = -0.6;
      return {
        build: { mass: 1.05, faun: true, hair: "curls" }, marble: false,
        pose: {
          hip: [0.03, -0.04, -0.01], pelvis: [0.3, -0.05, 0.06], chest: [-0.5, -0.16, -0.08], head: [-0.4, -0.5, -0.15],
          feet: [{ ankle: ankleFrom([0.2, 0, 0.12 + BALL_Z - HEEL_Z], BALL_Z, lp, 1), pitch: lp }, { ankle: ankleFrom([-0.1, 0, -0.12 + BALL_Z - HEEL_Z], BALL_Z, rp, -1), pitch: rp }],
          wrists: [[0.6, 1.52, 0.2], [-0.33, 1.87, 0.08]], poles: [[0.2, -1, -0.6], [-1, -0.3, -0.4]], handBend: [0.5, 0.4],
        },
        dress: () => [],
      };
    }
    case "lampbearer": {
      const st = stance(true, 0.0, 0.1, 0.22);
      const t = tray ?? [0.44, 1.58, 0.23];
      return {
        build: { mass: 0.95, hair: "curls" }, marble: false,
        pose: { ...st, chest: [-0.1, 0.02, 0.06], head: [0.3, 0.12, 0.04], wrists: [[t[0] - 0.02, t[1] - 0.09, t[2] - 0.03], armAt(-1, 0.05, 0.06, 0.2)], poles: [[1, -0.8, -0.3], [-0.35, -0.2, -1]], handBend: [-0.9, 0] },
        dress: () => [],
      };
    }
  }
}

/** Posed joints for world-space props. */
function jointAt(bones: Float32Array, bone: number, p: V3): V3 {
  const m = bones.subarray(bone * 16, bone * 16 + 16);
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

/** Apollo's bow: a recurved stave through the left hand, held upright. */
function bowPrims(bones: Float32Array): Prim[] {
  const g = jointAt(bones, L_HAND, add(mir(WRIST, 1), [0.004, -0.06, 0.012]));
  const pts: V3[] = [-0.55, -0.4, -0.2, 0, 0.2, 0.4, 0.55].map((t): V3 => [g[0] + 0.05 * (1 - (2 * t) ** 2) + (Math.abs(t) > 0.45 ? -0.03 : 0), g[1] + t, g[2] + 0.04 * (1 - (2 * t) ** 2)]);
  return chain(WORLD, pts, [0.006, 0.009, 0.012, 0.014, 0.012, 0.009, 0.006], Lab.Wood, Reg.Prop, 0.005);
}

/** The Doryphoros's spear, over the left shoulder from the left hand. */
function spearPrims(bones: Float32Array): Prim[] {
  const g = jointAt(bones, L_HAND, add(mir(WRIST, 1), [0.004, -0.06, 0.01]));
  const dir: V3 = [-0.1, 0.92, -0.38];
  return [C(WORLD, add(g, scl(dir, -0.5)), add(g, scl(dir, 1.6)), 0.014, 0.012, Lab.Wood, Reg.Prop, 0.004)];
}

// --- the field and its surface -----------------------------------------------------

/** Rigid inverse of a column-major bone matrix. */
function invert(m: ArrayLike<number>): number[] {
  const t: V3 = [m[12], m[13], m[14]];
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0,
    -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1];
}

interface Placed { p: Prim; inv: number[] | null; cx: number; cy: number; cz: number }

class Field {
  private readonly adds: Placed[];
  private readonly subs: Placed[];
  lab = 0;
  constructor(prims: Prim[], bones: Float32Array, private readonly clipY: number) {
    const place = (p: Prim): Placed => {
      if (p.bone === WORLD) return { p, inv: null, cx: p.c[0], cy: p.c[1], cz: p.c[2] };
      const c = jointAt(bones, p.bone, p.c);
      return { p, inv: invert(bones.subarray(p.bone * 16, p.bone * 16 + 16)), cx: c[0], cy: c[1], cz: c[2] };
    };
    this.adds = prims.filter((p) => !p.sub).map(place);
    this.subs = prims.filter((p) => p.sub).map(place);
  }
  private one(q: Placed, x: number, y: number, z: number): number {
    const m = q.inv;
    if (!m) return q.p.f(x, y, z);
    return q.p.f(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
  }
  /** Distance at a point; `lab` is left at the label of the nearest primitive. */
  at(x: number, y: number, z: number): number {
    let d = 1e9, best = 1e9;
    for (const q of this.adds) {
      const bound = len3(x - q.cx, y - q.cy, z - q.cz) - q.p.r;
      if (bound > d + q.p.k && bound > best) continue;
      const v = this.one(q, x, y, z);
      if (v < best) { best = v; this.lab = q.p.lab; }
      d = smin(d, v, q.p.k);
    }
    for (const q of this.subs) {
      if (len3(x - q.cx, y - q.cy, z - q.cz) - q.p.r > q.p.k) continue;
      d = smax(d, -this.one(q, x, y, z), q.p.k);
    }
    return this.clipY > -1e8 ? Math.max(d, this.clipY - y) : d;
  }
}

export interface StatueMesh { position: number[]; normal: number[]; colour: number[]; index: number[] }

/** Surface nets over a box at spacing h: one vertex per cell the surface crosses, quads across crossing edges. */
function polygonise(F: Field, lo: V3, hi: V3, h: number, out: StatueMesh, paint: (lab: number, p: V3, n: V3, F: Field) => RGB): void {
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const V = new Float32Array(nx * ny * nz);
  const id = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) V[id(i, j, k)] = F.at(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h);
  const cell = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number): number => (k * (ny - 1) + j) * (nx - 1) + i;
  const E: [number, number, number, number, number, number][] = [
    [0, 0, 0, 1, 0, 0], [0, 1, 0, 1, 1, 0], [0, 0, 1, 1, 0, 1], [0, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0], [0, 0, 1, 0, 1, 1], [1, 0, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [0, 1, 0, 0, 1, 1], [1, 1, 0, 1, 1, 1],
  ];
  const base = out.position.length / 3;
  let nv = 0;
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let sx = 0, sy = 0, sz = 0, c = 0;
    for (const [a0, a1, a2, b0, b1, b2] of E) {
      const va = V[id(i + a0, j + a1, k + a2)], vb = V[id(i + b0, j + b1, k + b2)];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += a0 + (b0 - a0) * t; sy += a1 + (b1 - a1) * t; sz += a2 + (b2 - a2) * t; c++;
    }
    if (!c) continue;
    const p: V3 = [lo[0] + (i + sx / c) * h, lo[1] + (j + sy / c) * h, lo[2] + (k + sz / c) * h];
    const e = h * 0.35;
    let n: V3 = [F.at(p[0] + e, p[1], p[2]) - F.at(p[0] - e, p[1], p[2]), F.at(p[0], p[1] + e, p[2]) - F.at(p[0], p[1] - e, p[2]), F.at(p[0], p[1], p[2] + e) - F.at(p[0], p[1], p[2] - e)];
    const L = len3(...n) || 1;
    n = [n[0] / L, n[1] / L, n[2] / L];
    F.at(p[0], p[1], p[2]);
    const col = paint(F.lab, p, n, F);
    out.position.push(...p); out.normal.push(...n); out.colour.push(...col);
    cell[cid(i, j, k)] = base + nv++;
  }
  // Quads: each grid edge with a sign change joins the four cells round it.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) out.index.push(a, c, b, a, d, c); else out.index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = V[id(i, j, k)] < 0;
    if (i < nx - 1 && v0 !== (V[id(i + 1, j, k)] < 0)) quad(cell[cid(i, j - 1, k - 1)], cell[cid(i, j, k - 1)], cell[cid(i, j, k)], cell[cid(i, j - 1, k)], !v0);
    if (j < ny - 1 && v0 !== (V[id(i, j + 1, k)] < 0)) quad(cell[cid(i - 1, j, k - 1)], cell[cid(i - 1, j, k)], cell[cid(i, j, k)], cell[cid(i, j, k - 1)], !v0);
    if (k < nz - 1 && v0 !== (V[id(i, j, k + 1)] < 0)) quad(cell[cid(i - 1, j - 1, k)], cell[cid(i, j - 1, k)], cell[cid(i, j, k)], cell[cid(i - 1, j, k)], !v0);
  }
}

/** A cone as an 8-sided tube, capped. */
function tube(out: StatueMesh, [a, b, r1, r2]: [V3, V3, number, number], c: RGB): void {
  const ax = sub(b, a), L = len3(...ax), t: V3 = [ax[0] / L, ax[1] / L, ax[2] / L];
  const ref: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u0: V3 = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
  const ul = len3(...u0), u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
  const v: V3 = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  const base = out.position.length / 3, m = 8;
  for (const [end, r] of [[a, r1], [b, r2]] as [V3, number][]) for (let j = 0; j < m; j++) {
    const an = (j / m) * Math.PI * 2, n: V3 = add(scl(u, Math.cos(an)), scl(v, Math.sin(an)));
    out.position.push(...add(end, scl(n, r))); out.normal.push(...n); out.colour.push(...c);
  }
  for (let j = 0; j < m; j++) {
    const j1 = (j + 1) % m;
    out.index.push(base + j, base + j1, base + m + j1, base + j, base + m + j1, base + m + j);
  }
}

// --- materials -------------------------------------------------------------------------

const BRONZE: RGB = [0.25, 0.17, 0.09], PATINA: RGB = [0.13, 0.27, 0.21], WORN: RGB = [0.52, 0.36, 0.17];
const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const scl3 = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
/** How open a surface point is to the sky round it, 0 deep in a fold to 1 in the open, from the field itself. */
function openness(p: V3, n: V3, F: Field, e: number): number {
  const a = F.at(p[0] + n[0] * e, p[1] + n[1] * e, p[2] + n[2] * e) / e, b = F.at(p[0] + n[0] * e * 2.5, p[1] + n[1] * e * 2.5, p[2] + n[2] * e * 2.5) / (e * 2.5);
  return Math.min(1, Math.max(0, (a + b) / 2));
}

/** Bronze: green verdigris in the hollows, rubbed bright where the metal is thin and stands out. */
function bronzePaint(lab: number, p: V3, n: V3, F: Field, scale: number): RGB {
  void lab;
  const e1 = 0.025 * scale, e2 = 0.06 * scale;
  const open = Math.min(1, Math.max(0, (F.at(p[0] + n[0] * e1, p[1] + n[1] * e1, p[2] + n[2] * e1) / e1 + F.at(p[0] + n[0] * e2, p[1] + n[1] * e2, p[2] + n[2] * e2) / e2) / 2));
  const thin = 1 - Math.min(1, Math.max(0, -F.at(p[0] - n[0] * e1, p[1] - n[1] * e1, p[2] - n[2] * e1) / e1));
  let c = mix3(BRONZE, PATINA, smooth(0.85, 0.4, open) * 0.75);
  // Rain runs the verdigris down from what faces the sky.
  c = mix3(c, PATINA, 0.15 * smooth(0.3, 0.9, n[1]));
  return mix3(c, WORN, smooth(0.35, 0.8, thin) * 0.55);
}

/** Painted marble: the flesh barely tinted, hair, eyes and lips coloured, the cloth's borders and cloak in colour. */
function marblePaint(lab: number, cloak: RGB): RGB {
  switch (lab) {
    case Lab.Hair: return [0.3, 0.19, 0.11];
    case Lab.Eye: return [0.42, 0.33, 0.27];
    case Lab.Lip: return [0.8, 0.6, 0.54];
    case Lab.Border: return [0.45, 0.13, 0.24];
    case Lab.Cloak: return cloak;
    case Lab.Metal: return [0.78, 0.66, 0.44];
    case Lab.Leather: return [0.45, 0.28, 0.16];
    case Lab.Wood: return [0.4, 0.28, 0.16];
    case Lab.Cloth: return [0.84, 0.81, 0.74];
    default: return [0.86, 0.78, 0.69];
  }
}

// --- building one ----------------------------------------------------------------------

export interface StatueBuilt extends StatueMesh { style: number; height: number }
const cache = new Map<string, StatueBuilt>();

/**
 * A statue's mesh at life size (1.7 m figure), feet on y 0, facing +z.
 * `lean` (the reduced tier) meshes the body coarsely and leaves out the fine
 * head, hands and feet: a few hundred triangles instead of thousands.
 */
export function buildStatue(kind: StatueKind, lean: boolean, opts: { tray?: V3; marble?: boolean; tiny?: boolean } = {}): StatueBuilt {
  const key = `${kind}|${lean}|${opts.tray?.join(",") ?? ""}|${opts.marble ?? ""}|${opts.tiny ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = design(kind, opts.tray);
  const marble = opts.marble ?? d.marble;
  const bones = solvePose(d.pose);
  const prims = [...bodyPrims(d.build), ...d.dress(bones)];
  const out: StatueMesh = { position: [], normal: [], colour: [], index: [] };
  const cloak: RGB = [0.62, 0.13, 0.09];
  const paint = (lab: number, p: V3, n: V3, F: Field): RGB => (marble ? scl3(marblePaint(lab, cloak), 0.58 + 0.42 * openness(p, n, F, 0.03)) : bronzePaint(lab, p, n, F, 1));
  const regions: [number, number][] = lean ? [[Reg.Body | Reg.Head | Reg.HandL | Reg.HandR | Reg.FootL | Reg.FootR, opts.tiny ? 0.085 : 0.055]]
    : [[Reg.Body, 0.04], [Reg.Head, 0.0165], [Reg.HandL, 0.0105], [Reg.HandR, 0.0105], [Reg.FootL, 0.017], [Reg.FootR, 0.017]];
  // Thin props (a bow, a spear) are tubes: a field fine enough for them would cost thousands of triangles.
  for (const p of prims) if (p.reg === Reg.Prop && p.tube) tube(out, p.tube, marble ? marblePaint(p.lab, cloak) : p.lab === Lab.Wood ? [0.3, 0.2, 0.11] : BRONZE);
  for (const [reg, h] of regions) {
    const ps = prims.filter((p) => p.reg & reg);
    if (!ps.some((p) => !p.sub)) continue;
    const F = new Field(ps, bones, d.bustY ?? -1e9);
    let lo: V3 = [1e9, 1e9, 1e9], hi: V3 = [-1e9, -1e9, -1e9];
    for (const p of ps) {
      if (p.sub) continue;
      const c = p.bone === WORLD ? p.c : jointAt(bones, p.bone, p.c);
      lo = [Math.min(lo[0], c[0] - p.r), Math.min(lo[1], c[1] - p.r), Math.min(lo[2], c[2] - p.r)];
      hi = [Math.max(hi[0], c[0] + p.r), Math.max(hi[1], c[1] + p.r), Math.max(hi[2], c[2] + p.r)];
    }
    // Only the parts of the region's box near its own surface: the head mesh
    // need not cover the neck's far end, the hands stop at the wrist.
    if (reg === Reg.Head) lo[1] = Math.max(lo[1], jointAt(bones, HEAD, [0, 1.44, 0])[1] - 0.06);
    if (d.bustY !== undefined) lo[1] = Math.max(lo[1], d.bustY - 0.05);
    lo = sub(lo, [h * 2, h * 2, h * 2]); hi = add(hi, [h * 2, h * 2, h * 2]);
    if (lo[1] >= hi[1]) continue;
    polygonise(F, lo, hi, h, out, paint);
  }
  // A bust stands on its pillar: its cut at the foot of the mesh.
  if (d.bustY !== undefined) for (let i = 1; i < out.position.length; i += 3) out.position[i] -= d.bustY;
  let top = 0;
  for (let i = 1; i < out.position.length; i += 3) top = Math.max(top, out.position[i]);
  const built = { ...out, style: marble ? STYLE_STATUE_MARBLE : STYLE_BRONZE, height: top };
  cache.set(key, built);
  return built;
}

/** Write a mesh into the town's store at `at`, turned by `yaw` (front to (sin yaw, cos yaw)), scaled. */
export function emitStatue(st: Sink, m: StatueMesh & { style: number }, at: V3, yaw: number, scale: number): number {
  const ca = Math.cos(yaw), sa = Math.sin(yaw), base = st.n;
  for (let i = 0; i < m.position.length / 3; i++) {
    const x = m.position[i * 3] * scale, y = m.position[i * 3 + 1] * scale, z = m.position[i * 3 + 2] * scale;
    const nx = m.normal[i * 3], ny = m.normal[i * 3 + 1], nz = m.normal[i * 3 + 2];
    st.vert([at[0] + x * ca + z * sa, at[1] + y, at[2] - x * sa + z * ca], [nx * ca + nz * sa, ny, -nx * sa + nz * ca],
      [m.colour[i * 3], m.colour[i * 3 + 1], m.colour[i * 3 + 2]], 0.5, m.style, 0, 0, [0, 0, 0, 0]);
  }
  for (let k = 0; k < m.index.length; k += 3) st.tri(base + m.index[k], base + m.index[k + 1], base + m.index[k + 2]);
  return m.index.length / 3;
}

// --- the equestrian horse --------------------------------------------------------------

/** The bronze horse: render/horse.ts's lofted horse held in an amble, the near fore raised, patinated. */
export function statueHorse(lean: boolean): StatueMesh & { style: number; back: number } {
  const h = buildHorse(lean, false);
  const b = new Float32Array(HORSE_BONES * 16);
  poseHorse("walk", 0.9, b, 1);
  const n = h.position.length / 3;
  const out: StatueMesh = { position: [], normal: [], colour: [], index: Array.from(h.index) };
  for (let i = 0; i < n; i++) {
    const p: V3 = [h.position[i * 3], h.position[i * 3 + 1], h.position[i * 3 + 2]];
    const nv: V3 = [h.normal[i * 4] / 127, h.normal[i * 4 + 1] / 127, h.normal[i * 4 + 2] / 127];
    const wb = h.skin[i * 4 + 2] / 255;
    let P: V3 = [0, 0, 0], N: V3 = [0, 0, 0];
    for (const [bone, w] of [[h.skin[i * 4], 1 - wb], [h.skin[i * 4 + 1], wb]] as [number, number][]) {
      if (w <= 0) continue;
      const m = b.subarray(bone * 16, bone * 16 + 16);
      P = add(P, scl([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]], w));
      N = add(N, scl([m[0] * nv[0] + m[4] * nv[1] + m[8] * nv[2], m[1] * nv[0] + m[5] * nv[1] + m[9] * nv[2], m[2] * nv[0] + m[6] * nv[1] + m[10] * nv[2]], w));
    }
    const L = len3(...N) || 1;
    N = [N[0] / L, N[1] / L, N[2] / L];
    // Verdigris under the belly and down the legs where rain runs, the back rubbed bright.
    const under = smooth(0.2, -0.7, N[1]);
    const c = mix3(mix3(BRONZE, PATINA, 0.1 + 0.4 * under), WORN, 0.3 * smooth(0.6, 1, N[1]));
    out.position.push(...P); out.normal.push(...N); out.colour.push(...c);
  }
  return { ...out, style: STYLE_BRONZE, back: 1.38 };
}

// --- bases ---------------------------------------------------------------------------------

/** 5 x 7 capitals for the dedications, a row per line, bit 4 the left. */
const FONT: Record<string, number[]> = {
  A: [4, 10, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], L: [16, 16, 16, 16, 16, 16, 31], M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], V: [17, 17, 17, 17, 17, 10, 4], X: [17, 17, 10, 4, 10, 17, 17],
  ".": [0, 0, 0, 4, 0, 0, 0], " ": [0, 0, 0, 0, 0, 0, 0],
};

/**
 * A statue base: a plinth, the die with its dedication cut into the front and
 * the letters picked out in red, a moulded cornice. hx, hz half sizes of the
 * die; y0 the ground, h the height to the top of the cornice. Front +z
 * turned by yaw (to (sin yaw, cos yaw)).
 */
export function statueBase(st: Sink, x: number, y0: number, z: number, yaw: number, hx: number, hz: number, h: number, lines: string[], seed: number): number {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const W = (u: number, y: number, v: number): V3 => [x + u * ca + v * sa, y0 + y, z - u * sa + v * ca];
  const Nw = (u: number, y: number, v: number): V3 => [u * ca + v * sa, y, -u * sa + v * ca];
  const stone: RGB = [0.86, 0.84, 0.79];
  // Profile: inset from the die's face against height (the plinth, a torus-like step, the die, the cyma and the crown).
  const prof: [number, number][] = [[0.1, 0], [0.1, 0.18], [0.06, 0.22], [0.035, 0.26], [0, 0.3], [0, h - 0.34], [0.02, h - 0.3], [0.06, h - 0.22], [0.07, h - 0.16], [0.08, h - 0.1], [0.08, h], [0.06, h], [0, h + 0.002]];
  let tris = 0;
  for (let k = 0; k + 1 < prof.length - 2; k++) {
    const [i0, ya] = prof[k], [i1, yb] = prof[k + 1];
    for (let side = 0; side < 4; side++) {
      // Each face with its own normal, so the mouldings keep their edges.
      const nu = [0, 1, 0, -1][side], nv = [1, 0, -1, 0][side];
      const ext = (i: number, sgn: number): [number, number] => (nu === 0 ? [sgn * (hx + i), nv * (hz + i)] : [nu * (hx + i), sgn * (hz + i)]);
      const s0 = side < 2 ? 1 : -1;
      const a = ext(i0, -s0), b = ext(i0, s0), c = ext(i1, s0), dd = ext(i1, -s0);
      const slope = (i0 - i1) / Math.max(1e-3, yb - ya);
      const n = Nw(nu, slope, nv);
      const L = Math.hypot(...n);
      const nn: V3 = [n[0] / L, n[1] / L, n[2] / L];
      const q = [W(a[0], ya, a[1]), W(b[0], ya, b[1]), W(c[0], yb, c[1]), W(dd[0], yb, dd[1])].map((p) => st.vert(p, nn, stone, seed, 11, 0, 0, [0, 0, 0, 0]));
      st.tri(q[0], q[1], q[2]); st.tri(q[0], q[2], q[3]); st.tri(q[0], q[2], q[1]); st.tri(q[0], q[3], q[2]); tris += 4;
    }
  }
  const tq = [W(-hx - 0.08, h, -hz - 0.08), W(hx + 0.08, h, -hz - 0.08), W(hx + 0.08, h, hz + 0.08), W(-hx - 0.08, h, hz + 0.08)].map((p) => st.vert(p, [0, 1, 0], stone, seed, 11, 0, 0, [0, 0, 0, 0]));
  st.tri(tq[0], tq[2], tq[1]); st.tri(tq[0], tq[3], tq[2]); tris += 2;
  // The dedication on the die's front, centred, a line or two of capitals.
  const red: RGB = [0.5, 0.1, 0.07];
  const lh = Math.min(0.085, (h - 0.8) / (lines.length * 1.6 + 1));
  const px = lh / 7;
  lines.forEach((line, li) => {
    const wch = line.length * 6 * px;
    const yTop = h - 0.45 - li * lh * 1.6;
    for (let ci = 0; ci < line.length; ci++) {
      const g = FONT[line[ci]] ?? FONT[" "];
      for (let row = 0; row < 7; row++) {
        let col = 0;
        while (col < 5) {
          if (!((g[row] >> (4 - col)) & 1)) { col++; continue; }
          let end = col;
          while (end + 1 < 5 && (g[row] >> (4 - end - 1)) & 1) end++;
          const u0 = -wch / 2 + (ci * 6 + col) * px, u1 = -wch / 2 + (ci * 6 + end + 1) * px;
          const ya = yTop - (row + 1) * px, yb = yTop - row * px, v = hz + 0.002;
          const q = [W(u0, ya, v), W(u1, ya, v), W(u1, yb, v), W(u0, yb, v)].map((p) => st.vert(p, Nw(0, 0, 1), red, seed, 24, 0, 0, [0, 0, 0, 0]));
          st.tri(q[0], q[1], q[2]); st.tri(q[0], q[2], q[3]); tris += 2;
          col = end + 1;
        }
      }
    }
  });
  return tris;
}

/** The town's statues that stand on their own bases, for the gate and the report. */
export const STATUE_KINDS: StatueKind[] = ["togate", "cuirassed", "rider", "apollo", "diana", "doryphoros", "faun", "lampbearer"];


// --- where they stand -------------------------------------------------------------------

/** Every statue placed, in the town's pack metres, for the shots that frame them (`?statuecam=`). */
export const STATUE_SPOTS: { kind: StatueKind; x: number; y: number; z: number; yaw: number; top: number }[] = [];

/** Honorands of the forum's bases (the dedications found there, shortened to fit a die). */
const DEDICATIONS = [
  ["M.LVCRETIO.DECIDIANO", "RVFO.II.VIR.III"], ["C.CVSPIO.C.F.PANSAE", "AED.II.VIR"], ["Q.SALLVSTIO.P.F", "II.VIR.I.D"],
  ["A.VMBRICIO.SCAVRO", "II.VIR.I.D"], ["M.HOLCONIO.CELERI", "SACERDOTI.AVGVSTI"], ["CN.ALLEIO.NIGIDIO", "MAIO.II.VIR"],
];

/** A statue on its base, its figure scaled so it stands `figureM` tall. */
function standing(st: Sink, kind: StatueKind, lean: boolean, x: number, y: number, z: number, yaw: number, figureM: number, base: { hx: number; hz: number; h: number; lines: string[] }, seed: number, marble?: boolean): number {
  let tris = statueBase(st, x, y, z, yaw, base.hx, base.hz, base.h, base.lines, seed);
  const m = buildStatue(kind, lean, { marble });
  const s = figureM / 1.7;
  tris += emitStatue(st, m, [x, y + base.h, z], yaw, s);
  STATUE_SPOTS.push({ kind, x, y: y + base.h, z, yaw, top: y + base.h + m.height * s });
  return tris;
}

/**
 * One of the forum's honorific statues on its base: a togate magistrate
 * (bronze or painted marble, alternately) or, at the ends, an equestrian
 * bronze on a long high base. (ux, uz) the forum's long axis; `face` the
 * togatus's facing; k the base's place along the line.
 */
export function forumStatue(st: Sink, x: number, g: number, z: number, ux: number, uz: number, k: number, rider: boolean, face: number, seed: number): number {
  const lines = DEDICATIONS[(k + 3 + (rider ? 0 : 2)) % DEDICATIONS.length];
  if (!rider) return standing(st, "togate", false, x, g, z, face, 1.9, { hx: 0.55, hz: 0.5, h: 2.0, lines }, seed, k % 2 === 0);
  const hyaw = k > 0 ? Math.atan2(-ux, -uz) : Math.atan2(ux, uz);
  const h = 2.4, s = 1.15;
  let tris = statueBase(st, x, g, z, hyaw, 0.62, 1.55, h, lines, seed);
  const horse = statueHorse(false);
  tris += emitStatue(st, horse, [x, g + h, z], hyaw, s);
  // The rider astride, his seat just behind the withers.
  const rider_ = buildStatue("rider", false);
  const fx = Math.sin(hyaw), fz = Math.cos(hyaw);
  const seat: V3 = [x + fx * 0.12 * s, g + h + (1.3 - 0.83) * s, z + fz * 0.12 * s];
  tris += emitStatue(st, rider_, seat, hyaw, s);
  STATUE_SPOTS.push({ kind: "rider", x, y: g + h, z, yaw: hyaw, top: seat[1] + rider_.height * s });
  return tris;
}

/** The Dancing Faun on a small moulded base by the impluvium, 0.71 m to his raised hand. */
export function faunStatue(st: Sink, x: number, floor: number, z: number, yaw: number, lean: boolean, seed: number): number {
  let tris = statueBase(st, x, floor - 0.1, z, yaw, 0.2, 0.2, 0.6, [], seed);
  const m = buildStatue("faun", lean);
  const s = 0.71 / m.height;
  tris += emitStatue(st, m, [x, floor + 0.5, z], yaw, s);
  STATUE_SPOTS.push({ kind: "faun", x, y: floor + 0.5, z, yaw, top: floor + 0.5 + 0.71 });
  return tris;
}

/** The long axis, centre and half sizes of a ring, by its principal axes. */
function axes(r: number[]): { cx: number; cz: number; ux: number; uz: number; hu: number; hv: number } {
  const n = r.length / 2;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += r[i * 2]; cz += r[i * 2 + 1]; }
  cx /= n; cz /= n;
  let xx = 0, zz = 0, xz = 0;
  for (let i = 0; i < n; i++) { const dx = r[i * 2] - cx, dz = r[i * 2 + 1] - cz; xx += dx * dx; zz += dz * dz; xz += dx * dz; }
  const th = 0.5 * Math.atan2(2 * xz, xx - zz), ux = Math.cos(th), uz = Math.sin(th);
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (let i = 0; i < n; i++) {
    const dx = r[i * 2] - cx, dz = r[i * 2 + 1] - cz, u = dx * ux + dz * uz, v = -dx * uz + dz * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return { cx: cx + ux * (u0 + u1) / 2 - uz * (v0 + v1) / 2, cz: cz + uz * (u0 + u1) / 2 + ux * (v0 + v1) / 2, ux, uz, hu: (u1 - u0) / 2, hv: (v1 - v0) / 2 };
}

/** Nearest approach of two polylines. */
function crossing(a: number[], b: number[]): [number, number] | null {
  let best = 1e9, at: [number, number] | null = null;
  for (let i = 0; i + 3 < a.length; i += 2) for (let j = 0; j + 3 < b.length; j += 2) {
    for (let t = 0; t <= 1; t += 0.1) {
      const px = a[i] + (a[i + 2] - a[i]) * t, pz = a[i + 1] + (a[i + 3] - a[i + 1]) * t;
      const dx = b[j + 2] - b[j], dz = b[j + 3] - b[j + 1], L2 = dx * dx + dz * dz || 1;
      const s = Math.max(0, Math.min(1, ((px - b[j]) * dx + (pz - b[j + 1]) * dz) / L2));
      const d = Math.hypot(px - b[j] - dx * s, pz - b[j + 1] - dz * s);
      if (d < best) { best = d; at = [px, pz]; }
    }
  }
  return best < 3 ? at : null;
}

/**
 * The statues away from the forum: Apollo and Diana facing each other across
 * his sanctuary, as the two bronzes were found; Holconius Rufus in his
 * cuirass at the Stabian crossroads, where his base stood; the Doryphoros in
 * the Samnite Palaestra. `ground` in pack metres; floors stand kerb high.
 */
export function placeTownStatues(st: Sink, data: { publics: { name: string; ring: number[] }[]; streets: { name: string; pts: number[]; carriageM: number; sidewalkM: number }[] },
  ground: (x: number, z: number) => number, kerb: number, lean: boolean, seed: number): { tris: number; placed: string[] } {
  let tris = 0;
  const placed: string[] = [];
  const floorOf = (r: number[]): number => { let g = 1e9; for (let i = 0; i < r.length; i += 2) g = Math.min(g, ground(r[i], r[i + 1])); return g + kerb; };
  const apollo = data.publics.find((p) => /Tempio di Apollo/.test(p.name));
  if (apollo) {
    const o = axes(apollo.ring), g = floorOf(apollo.ring);
    // In front of the portico on the two long sides, a third of the way from the front, facing across.
    for (const [kind, side] of [["apollo", 1], ["diana", -1]] as [StatueKind, number][]) {
      const u = o.hu * 0.35, v = side * (o.hv - 4.2);
      const x = o.cx + o.ux * u - o.uz * v, z = o.cz + o.uz * u + o.ux * v;
      const yaw = Math.atan2(o.uz * side, -o.ux * side);
      tris += kind === "diana"
        ? standing(st, "diana", lean, x, g, z, yaw, 1.7, { hx: 0.32, hz: 0.32, h: 1.75, lines: ["DIANAE"] }, seed)
        : standing(st, "apollo", lean, x, g, z, yaw, 1.75, { hx: 0.45, hz: 0.45, h: 1.1, lines: ["APOLLINI"] }, seed);
      placed.push(kind);
    }
  }
  let stabia: (typeof data.streets)[number] | undefined, abb: (typeof data.streets)[number] | undefined, at: [number, number] | null = null;
  for (const s of data.streets.filter((q) => /^Via Stabiana$/.test(q.name))) for (const a of data.streets.filter((q) => /Abbondanza/.test(q.name))) {
    const c: [number, number] | null = at ? null : crossing(s.pts, a.pts);
    if (c) { at = c; stabia = s; abb = a; }
  }
  if (at && stabia && abb) {
    // On the pavement at the crossroads' north-west corner, facing the junction.
    const dir = (p: number[]): [number, number] => { const dx = p[p.length - 2] - p[0], dz = p[p.length - 1] - p[1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; };
    let [sx, sz] = dir(stabia.pts), [ax, az] = dir(abb.pts);
    // Perpendiculars pointing north (-z) and west (-x).
    let nx = -sz, nz = sx; if (nz > 0) { nx = -nx; nz = -nz; }
    let wx = -az, wz = ax; if (wx > 0) { wx = -wx; wz = -wz; }
    void sx; void ax;
    const dn = abb.carriageM / 2 + abb.sidewalkM * 0.55, dw = stabia.carriageM / 2 + stabia.sidewalkM * 0.55;
    const x = at[0] + nx * dn + wx * dw, z = at[1] + nz * dn + wz * dw;
    const yaw = Math.atan2(at[0] - x, at[1] - z);
    tris += standing(st, "cuirassed", lean, x, ground(x, z) + kerb, z, yaw, 1.85, { hx: 0.42, hz: 0.42, h: 1.6, lines: ["M.HOLCONIO.M.F", "RVFO.TRIB.MIL"] }, seed);
    placed.push("holconius");
  }
  const pal = data.publics.find((p) => /Palestra Sannitica/.test(p.name));
  if (pal) {
    const o = axes(pal.ring), g = floorOf(pal.ring);
    const x = o.cx + o.ux * o.hu * 0.45, z = o.cz + o.uz * o.hu * 0.45;
    const yaw = Math.atan2(-o.ux, -o.uz);
    tris += standing(st, "doryphoros", lean, x, g, z, yaw, 1.95, { hx: 0.5, hz: 0.5, h: 1.0, lines: [] }, seed);
    placed.push("doryphoros");
  }
  return { tris, placed };
}
