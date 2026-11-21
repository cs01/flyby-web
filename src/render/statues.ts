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
import { HEAD as HORSE_HEAD, HORSE_BONES, LEGS, NECK, poseHorse } from "./horse";
import type { Sink } from "./pompeiiorders";

type RGB = [number, number, number];
const { PELVIS_PIVOT, HIP, KNEE, ANKLE, SHOULDER, ELBOW, WRIST, HEEL_Z, BALL_Z, TOE_Z } = FOLK_REST;
void PELVIS_PIVOT;

/**
 * GPU bytes of all the statues' meshes, built after the town (render/pompeii.ts):
 * measured over the committed pack with a little headroom, held to it and
 * to within a quarter of it by test/pompeii.check.ts. The reduced tier
 * builds only the few placed outside the forum, at a coarse grid.
 */
export const STATUE_FULL_BYTES = Math.round(14 * 1048576), STATUE_LEAN_BYTES = Math.round(0.25 * 1048576);

/** Surface styles: the town shader's bronze, and statue marble (no branch of its own: plain lit, painted by vertex colour). */
export const STYLE_BRONZE = 17, STYLE_STATUE_MARBLE = 25;

// Bones, as render/folk.ts numbers them.
const PELVIS = 0, CHEST = 1, HEAD = 2, L_THIGH = 3, L_SHIN = 4, L_FOOT = 5, R_THIGH = 6, R_SHIN = 7, R_FOOT = 8;
const L_ARM = 9, L_FORE = 10, L_HAND = 11, R_ARM = 12, R_FORE = 13, R_HAND = 14, L_TOE = 15, R_TOE = 16;
/** A primitive placed in world (posed) space rather than on a bone. */
const WORLD = -1;

/** What a surface is, for its colour. */
const enum Lab { Skin, Hair, Cloth, Border, Eye, Lip, Metal, Cloak, Leather, Wood, Sinus, Balteus }
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

type HandMode = "relaxed" | "open" | "grip" | "spread";
export interface Build {
  /** Muscle and girth, 1 an athletic man. */
  mass: number;
  woman?: boolean;
  /** The Faun's (and a satyr's) horns, pointed ears and tail. */
  faun?: boolean;
  /** A child: the head and the limbs' girth larger for the height. */
  child?: boolean;
  hair: "locks" | "curls" | "knot" | "beard";
  hands: [HandMode, HandMode];
  /** Nude: the muscles of the belly are cut, which drapery would hide. */
  nude?: boolean;
  shoes?: boolean;
}

/** A nude body round the rest skeleton (render/folk.ts), each part on its bone, its muscles as masses blended into it. */
function bodyPrims(b: Build): Prim[] {
  const m = b.mass, w = !!b.woman;
  const out: Prim[] = [];
  const BH = Reg.Body;
  // Pelvis, hips, the iliac crests.
  out.push(E(PELVIS, [0, 0.93, -0.005], [(w ? 0.162 : 0.148) * m, 0.11, 0.1 * m], Lab.Skin, BH, 0.04));
  out.push(E(PELVIS, [0, 0.985, 0.035], [0.11 * m, 0.075, 0.07 * m], Lab.Skin, BH, 0.03));
  if (!w && b.nude) out.push(E(PELVIS, [0, 0.815, 0.075], [0.026, 0.035, 0.028], Lab.Skin, BH, 0.015));
  // Ribcage, back, belly; the neck with its two sternomastoids.
  out.push(E(CHEST, [0, 1.2, -0.01], [0.14 * m, 0.165, 0.095 * m], Lab.Skin, BH, 0.035));
  out.push(E(CHEST, [0, 1.25, -0.05], [0.145 * m, 0.15, 0.06 * m], Lab.Skin, BH, 0.035));
  out.push(E(CHEST, [0, 1.1, 0.052], [0.072 * m, 0.12, 0.042 * m], Lab.Skin, BH, 0.03));
  if (b.nude && !w) for (const y of [1.155, 1.095, 1.035]) out.push(P(CHEST, ellipsoid([0, y, 0.099 * m], [0.055, 0.004, 0.012]), [0, y, 0.1], 0.06, Lab.Skin, BH, 0.008, true));
  out.push(C(CHEST, [0, 1.36, -0.02], [0, 1.52, 0.0], 0.05 * m, 0.045 * m, Lab.Skin, BH | Reg.Head, 0.03));
  for (const s of [1, -1]) {
    if (w) out.push(E(CHEST, [0.068 * s, 1.25, 0.072], [0.058, 0.058, 0.05], Lab.Skin, BH, 0.03));
    else out.push(E(CHEST, [0.068 * s, 1.285, 0.058], [0.072 * m, 0.048, 0.034 * m], Lab.Skin, BH, 0.03));
    out.push(E(CHEST, [0.105 * s, 1.03, 0.01], [0.05 * m, 0.075, 0.065 * m], Lab.Skin, BH, 0.03));
    out.push(E(CHEST, [0.12 * s, 1.22, -0.02], [0.04 * m, 0.09, 0.07 * m], Lab.Skin, BH, 0.03));
    out.push(C(CHEST, [0.15 * s, 1.405, -0.035], [0.03 * s, 1.45, -0.035], 0.04 * m, 0.05 * m, Lab.Skin, BH, 0.035));
    out.push(C(CHEST, [0.02 * s, 1.415, 0.045], [0.16 * s, 1.425, 0.0], 0.011, 0.011, Lab.Skin, BH, 0.015));
    out.push(C(CHEST, [0.045 * s, 1.5, 0.012], [0.015 * s, 1.41, 0.045], 0.014, 0.012, Lab.Skin, BH | Reg.Head, 0.015));
    out.push(E(PELVIS, [0.115 * s, 0.97, 0.02], [0.04, 0.035, 0.05], Lab.Skin, BH, 0.03));
    out.push(E(PELVIS, [0.07 * s, 0.87, -0.06], [0.085 * m, 0.095, 0.075 * m], Lab.Skin, BH, 0.03));
    // Arm: deltoid, biceps, triceps, the elbow, the forearm's two masses.
    const arm = s > 0 ? L_ARM : R_ARM, fore = s > 0 ? L_FORE : R_FORE, hand = s > 0 ? L_HAND : R_HAND;
    const sh = mir(SHOULDER, s), el = mir(ELBOW, s), wr = mir(WRIST, s);
    out.push(E(arm, [0.185 * s, 1.36, -0.015], [0.055 * m, 0.08, 0.06 * m], Lab.Skin, BH, 0.03));
    out.push(C(arm, sh, el, 0.042 * m, 0.033 * m, Lab.Skin, BH, 0.02));
    out.push(E(arm, add(lerp3(sh, el, 0.5), [0, 0, 0.02]), [0.034 * m, 0.07, 0.034 * m], Lab.Skin, BH, 0.02));
    out.push(E(arm, add(lerp3(sh, el, 0.38), [0, 0, -0.022]), [0.032 * m, 0.085, 0.032 * m], Lab.Skin, BH, 0.02));
    out.push(E(fore, add(el, [0, 0, -0.025]), [0.02, 0.02, 0.018], Lab.Skin, BH, 0.012));
    out.push(C(fore, el, wr, 0.036 * m, 0.023, Lab.Skin, BH, 0.02));
    out.push(E(fore, add(lerp3(el, wr, 0.25), [0.006 * s, 0, 0.008]), [0.037 * m, 0.075, 0.032 * m], Lab.Skin, BH, 0.02));
    out.push(C(fore, lerp3(el, wr, 0.82), wr, 0.026, 0.023, Lab.Skin, s > 0 ? Reg.HandL : Reg.HandR, 0.012));
    out.push(...handPrims(s, hand, b.hands[s > 0 ? 0 : 1]));
    // Leg: thigh with its quadriceps (and the teardrop over the knee),
    // hamstrings and adductors, the kneecap, the shin, the calf's two heads.
    const th = s > 0 ? L_THIGH : R_THIGH, shin = s > 0 ? L_SHIN : R_SHIN;
    const hp = mir(HIP, s), kn = mir(KNEE, s), an = mir(ANKLE, s);
    out.push(C(th, hp, kn, 0.078 * m, 0.046 * m, Lab.Skin, BH, 0.035));
    out.push(E(th, add(lerp3(hp, kn, 0.45), [0.012 * s, 0, 0.028]), [0.062 * m, 0.16, 0.055 * m], Lab.Skin, BH, 0.03));
    out.push(E(th, add(lerp3(hp, kn, 0.82), [-0.025 * s, 0, 0.02]), [0.035 * m, 0.05, 0.035 * m], Lab.Skin, BH, 0.02));
    out.push(E(th, add(lerp3(hp, kn, 0.42), [0, 0, -0.03]), [0.058 * m, 0.15, 0.05 * m], Lab.Skin, BH, 0.03));
    out.push(E(th, add(lerp3(hp, kn, 0.25), [-0.03 * s, 0, 0]), [0.05 * m, 0.1, 0.05 * m], Lab.Skin, BH, 0.03));
    out.push(E(shin, add(kn, [0, -0.005, 0.035]), [0.025, 0.03, 0.015], Lab.Skin, BH, 0.012));
    out.push(E(shin, kn, [0.05, 0.045, 0.045], Lab.Skin, BH, 0.02));
    out.push(C(shin, kn, an, 0.044 * m, 0.026, Lab.Skin, BH, 0.025));
    for (const d of [0.016, -0.016]) out.push(E(shin, add(lerp3(kn, an, 0.28), [d, 0, -0.032]), [0.03 * m, 0.085, 0.035 * m], Lab.Skin, BH, 0.02));
    out.push(C(shin, lerp3(kn, an, 0.8), an, 0.031, 0.026, Lab.Skin, s > 0 ? Reg.FootL : Reg.FootR, 0.02));
    out.push(...footPrims(s, !!b.shoes));
  }
  out.push(...headPrims(b));
  if (b.faun) out.push(...chain(PELVIS, [[0, 0.93, -0.085], [0, 0.95, -0.13], [0, 1.0, -0.16], [0, 1.04, -0.15]], [0.016, 0.014, 0.01, 0.004], Lab.Hair, BH, 0.015));
  return b.child ? out.map((p) => (p.reg & Reg.Head ? scaleAbout(p, [0, 1.46, 0], 1.3) : p)) : out;
}

/** A primitive scaled about a point (a child's head). */
function scaleAbout(p: Prim, o: V3, k: number): Prim {
  const f = p.f;
  return { ...p, f: (x, y, z) => f(o[0] + (x - o[0]) / k, o[1] + (y - o[1]) / k, o[2] + (z - o[2]) / k) * k, c: add(o, scl(sub(p.c, o), k)), r: p.r * k };
}

/**
 * Palm, four fingers and the thumb, each finger in three joints: relaxed (a
 * little curled), open (an orator's hand, straight and slightly spread),
 * spread (the Faun's, snapping) or a grip round a scroll, a rein or a staff.
 */
function handPrims(s: number, bone: number, mode: HandMode): Prim[] {
  const reg = s > 0 ? Reg.HandL : Reg.HandR;
  const wr = mir(WRIST, s), dn: V3 = [0.04 * s, -0.99, 0.12], palm: V3 = [-s, 0, 0], fw: V3 = [0, 0, 1];
  const at = (d: number, inward: number, fwd: number): V3 => add(wr, add(scl(dn, d), add(scl(palm, inward), scl(fw, fwd))));
  const out: Prim[] = [E(bone, at(0.05, 0, 0.004), [0.017, 0.052, 0.042], Lab.Skin, reg, 0.01)];
  const curl = mode === "grip" ? [1.15, 1.35, 0.9] : mode === "open" ? [0.06, 0.08, 0.06] : mode === "spread" ? [0.12, 0.15, 0.1] : [0.3, 0.4, 0.3];
  const fan = mode === "spread" ? 0.16 : mode === "open" ? 0.06 : 0.02;
  [0.027, 0.009, -0.009, -0.026].forEach((z, i) => {
    const L = [0.078, 0.088, 0.083, 0.066][i], r = [0.0085, 0.0088, 0.0084, 0.0074][i];
    const seg = [L * 0.45, L * 0.32, L * 0.23];
    // Each finger leaves the knuckle fanned out from the middle, then curls toward the palm.
    const spread = (i - 1.5) * fan;
    const along: V3 = norm3(add(dn, scl(fw, -spread)));
    let p: V3 = at(0.095, 0.002, z), a = 0;
    const pts: V3[] = [p];
    for (const [k, L1] of seg.entries()) {
      a += curl[k];
      p = add(p, scl(norm3(add(scl(along, Math.cos(a)), scl(palm, Math.sin(a)))), L1));
      pts.push(p);
    }
    out.push(...chain(bone, pts, [r, r * 0.95, r * 0.86, r * 0.75], Lab.Skin, reg, 0.004));
  });
  // The thumb from the heel of the palm, forward and across.
  const tc = mode === "grip" ? 0.9 : mode === "open" || mode === "spread" ? -0.2 : 0.3;
  let t: V3 = at(0.025, 0.006, 0.033);
  const tp: V3[] = [t];
  for (const [k, L1] of [0.035, 0.032, 0.026].entries()) {
    const a = 0.5 + tc * (k + 1) * 0.5;
    t = add(t, scl(norm3(add(add(scl(dn, 0.6), scl(fw, Math.cos(a))), scl(palm, Math.sin(a)))), L1));
    tp.push(t);
  }
  out.push(...chain(bone, tp, [0.012, 0.0105, 0.0095, 0.008], Lab.Skin, reg, 0.006));
  return out;
}
const norm3 = (a: V3): V3 => { const L = len3(...a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };

/** Heel, arch and ball, five toes on their own bone, flat on the sole; shod, a calceus over it laced to the ankle. */
function footPrims(s: number, shod: boolean): Prim[] {
  const reg = s > 0 ? Reg.FootL : Reg.FootR, ft = s > 0 ? L_FOOT : R_FOOT, toe = s > 0 ? L_TOE : R_TOE, shin = s > 0 ? L_SHIN : R_SHIN;
  const x = ANKLE[0] * s;
  const sole = (f: F): F => (px, py, pz) => Math.max(f(px, py, pz), -py);
  const lab = shod ? Lab.Leather : Lab.Skin, pad = shod ? 0.006 : 0;
  const out: Prim[] = [
    P(ft, sole(sphere([x, 0.036, HEEL_Z + 0.03], 0.034 + pad)), [x, 0.036, HEEL_Z + 0.03], 0.04, lab, reg, 0.02),
    P(ft, sole(ellipsoid([x + 0.004 * s, 0.03, ANKLE[2] + 0.085], [0.04 + pad, 0.034 + pad, 0.1])), [x, 0.03, ANKLE[2] + 0.085], 0.1, lab, reg, 0.025),
    E(ft, [x + 0.016 * s, ANKLE[1], ANKLE[2]], [0.014, 0.018, 0.016], lab, reg, 0.012),
    E(ft, [x - 0.016 * s, ANKLE[1] + 0.005, ANKLE[2] - 0.005], [0.014, 0.018, 0.016], lab, reg, 0.012),
  ];
  if (shod) {
    out.push(P(toe, sole(ellipsoid([x - 0.003 * s, 0.022, BALL_Z + 0.02], [0.046, 0.026, 0.055])), [x, 0.02, BALL_Z + 0.02], 0.06, Lab.Leather, reg, 0.02));
    out.push(C(shin, [ANKLE[0] * s, 0.06, ANKLE[2]], [ANKLE[0] * s, 0.14, ANKLE[2] + 0.004], 0.04, 0.037, Lab.Leather, reg, 0.015));
    return out;
  }
  [[-0.026, 0.013, 0.07], [-0.008, 0.0095, 0.064], [0.007, 0.009, 0.058], [0.02, 0.0085, 0.05], [0.031, 0.008, 0.042]].forEach(([dx, r, L]) => {
    const a: V3 = [x + dx * s, 0.016, BALL_Z - 0.01], b: V3 = [x + dx * 1.1 * s, r + 0.002, BALL_Z - 0.01 + L];
    out.push(P(toe, sole(cone(a, b, r * 1.15, r)), lerp3(a, b, 0.5), L, Lab.Skin, reg, 0.005));
  });
  void TOE_Z;
  return out;
}

/**
 * A Roman portrait head: the skull, the brow ridge over deep sockets with
 * lids, a strong nose, the philtrum and lips, chin and jaw, cheekbones,
 * ears; short hair combed forward in locks from the crown (or the Faun's
 * curls, a god's knot, a herm's beard).
 */
function headPrims(b: Build): Prim[] {
  const R = Reg.Head, H = HEAD;
  const out: Prim[] = [
    E(H, [0, 1.607, -0.012], [0.072, 0.088, 0.098], Lab.Skin, R, 0.025),
    E(H, [0, 1.56, 0.03], [0.06, 0.077, 0.068], Lab.Skin, R, 0.025),
    E(H, [0, 1.635, 0.048], [0.06, 0.035, 0.045], Lab.Skin, R, 0.02),
    C(H, [-0.046, 1.611, 0.076], [0.046, 1.611, 0.076], b.faun ? 0.014 : 0.012, b.faun ? 0.014 : 0.012, Lab.Skin, R, 0.014),
    E(H, [0, 1.607, 0.088], [0.014, 0.012, 0.01], Lab.Skin, R, 0.01),
    C(H, [0, 1.6, 0.09], [0, 1.556, b.faun ? 0.11 : 0.117], 0.0085, b.faun ? 0.014 : 0.0115, Lab.Skin, R, 0.008),
    E(H, [0, 1.53, 0.097], [0.015, 0.01, 0.008], Lab.Skin, R, 0.008),
    E(H, [0, 1.522, 0.096], [0.02, 0.006, 0.009], Lab.Lip, R, 0.005),
    E(H, [0, 1.508, 0.094], [0.017, 0.0075, 0.009], Lab.Lip, R, 0.005),
    P(H, ellipsoid([0, 1.5155, 0.104], [0.019, 0.0012, 0.009]), [0, 1.516, 0.1], 0.02, Lab.Lip, R, 0.003, true),
    E(H, [0, 1.483, 0.082], [0.022, 0.02, 0.018], Lab.Skin, R, 0.012),
  ];
  for (const s of [1, -1]) {
    out.push(E(H, [0.011 * s, 1.553, 0.103], [0.009, 0.008, 0.009], Lab.Skin, R, 0.006));
    out.push(C(H, [0.058 * s, 1.545, 0.0], [0.024 * s, 1.484, 0.065], 0.017, 0.014, Lab.Skin, R, 0.015));
    out.push(E(H, [0.045 * s, 1.575, 0.066], [0.022, 0.015, 0.02], Lab.Skin, R, 0.012));
    out.push(E(H, [0.04 * s, 1.54, 0.06], [0.025, 0.025, 0.025], Lab.Skin, R, 0.015));
    out.push(P(H, sphere([0.031 * s, 1.592, 0.094], 0.017), [0.031 * s, 1.592, 0.094], 0.018, Lab.Skin, R, 0.008, true));
    out.push(P(H, sphere([0.031 * s, 1.591, 0.08], 0.0128), [0.031 * s, 1.591, 0.08], 0.013, Lab.Eye, R, 0.003));
    out.push(E(H, [0.031 * s, 1.599, 0.088], [0.017, 0.006, 0.01], Lab.Skin, R, 0.004));
    out.push(E(H, [0.031 * s, 1.583, 0.088], [0.015, 0.004, 0.008], Lab.Skin, R, 0.004));
    if (b.faun) out.push(C(H, [0.074 * s, 1.58, -0.012], [0.094 * s, 1.64, -0.035], 0.012, 0.003, Lab.Skin, R, 0.01));
    else out.push(E(H, [0.074 * s, 1.585, -0.012], [0.01, 0.03, 0.02], Lab.Skin, R, 0.01));
    if (b.faun) out.push(C(H, [0.028 * s, 1.66, 0.062], [0.046 * s, 1.715, 0.035], 0.009, 0.002, Lab.Hair, R, 0.008));
  }
  // Hair: a shell over the skull above the hairline. Locks are ridges
  // running forward from the crown, their tips a ragged fringe on the brow.
  const fringe = (x: number): number => 0.008 * Math.abs(Math.sin(x * 110));
  const hairline = (x: number, y: number, z: number): number => 1.52 + (b.woman ? 0.11 : 0.125) * smooth(-0.06, 0.08, z) - fringe(x) - y;
  const cap = ellipsoid([0, 1.627, -0.018], [0.08, 0.086, 0.102]);
  const curls = b.hair === "curls" || b.hair === "beard";
  out.push(P(H, (x, y, z) => {
    const d = cap(x, y, z);
    if (curls) return Math.max(d - 0.007 * Math.sin(x * 150) * Math.sin(y * 160 + 1.3) * Math.sin(z * 140 + 0.7), hairline(x, y, z));
    const ph = Math.atan2(x, z + 0.06) * 13 + (y - 1.6) * 30;
    return Math.max(d - 0.0045 * (1 - Math.abs(Math.sin(ph))) * 2 + 0.0035, hairline(x, y, z));
  }, [0, 1.62, -0.02], 0.11, Lab.Hair, R, 0.006));
  if (b.hair === "knot") {
    out.push(E(H, [0, 1.705, 0.005], [0.033, 0.024, 0.03], Lab.Hair, R, 0.012));
    for (const s of [1, -1]) out.push(...chain(H, [[0.062 * s, 1.56, -0.03], [0.07 * s, 1.49, -0.02], [0.074 * s, 1.43, -0.005]], [0.014, 0.012, 0.008], Lab.Hair, R | Reg.Body, 0.01));
  }
  if (b.hair === "beard") {
    const beard = ellipsoid([0, 1.495, 0.055], [0.065, 0.07, 0.055]);
    out.push(P(H, (x, y, z) => beard(x, y, z) - 0.006 * Math.sin(x * 140) * Math.sin(y * 150) * Math.sin(z * 130), [0, 1.49, 0.05], 0.08, Lab.Hair, R, 0.01));
  }
  if (b.woman) out.push(E(H, [0, 1.6, -0.1], [0.04, 0.035, 0.035], Lab.Hair, R, 0.015));
  return out;
}

// --- dress ---------------------------------------------------------------------------

/** A sharp-ridged fold: 1 on the ridge, falling to -1 in the round hollow between. */
const ridge = (t: number): number => 1 - 2 * Math.abs(Math.sin(t * 0.5));

/**
 * A skirt of cloth on the pelvis from `top` to a hem at `hem` (front) and
 * `hemBack`, flaring as it falls and pooling on the base. Its folds hang
 * straight down, deepening from `depthTop` at the waist to `depthHem`.
 */
function skirt(top: number, rTop: number, rHem: number, hem: number, hemBack: number, n: number, depthTop: number, depthHem: number, lab: Lab, extra?: F): Prim {
  const f: F = (x, y, z) => {
    const t = Math.max(0, Math.min(1, (top - y) / (top - hem)));
    const r = rTop + (rHem - rTop) * Math.pow(t, 0.7);
    const th = Math.atan2(x, z);
    const A = depthTop + (depthHem - depthTop) * t;
    const fold = A * ridge(n * th + 2.2 * y + 0.9 * Math.sin(3 * th + 1.7 * y));
    let d = Math.hypot(x, (z - 0.01) / 0.82) * 0.88 - r * 0.88 - fold;
    if (extra) d -= extra(x, y, z);
    const hy = hem + (hemBack - hem) * (1 - Math.cos(th)) / 2;
    return Math.max(d, y - top, hy - y, -y);
  };
  return P(PELVIS, f, [0, (top + hem) / 2, 0], (top - hem) / 2 + rHem + 0.08, lab, Reg.Body, 0.04);
}

/**
 * The toga of a magistrate (the praetexta, its border in purple), over the
 * free leg's knee and thigh, which press through the cloth: the skirt to
 * the feet in deep straight folds pooling on the base, catenaries swinging
 * across the front from the sinus, the wrap over the left shoulder with its
 * folds running down to the right hip, the balteus, the sinus, the umbo,
 * the left arm wrapped and the end hanging from the forearm.
 */
function togaPrims(bones: Float32Array, freeRight: boolean): Prim[] {
  const B = Reg.Body;
  // Catenaries on the front, hanging between the left forearm and the right hip.
  const cats = (x: number, y: number, z: number): number => {
    if (z < 0.02) return 0;
    let v = 0;
    for (const [y0, a] of [[0.86, 0.22], [0.7, 0.28], [0.53, 0.34]] as [number, number][]) {
      const g = y - (y0 + a * (Math.cosh((x - 0.03) / a) - 1));
      v += 0.016 * Math.exp(-(g * g) / (0.035 * 0.035));
    }
    return v * smooth(0.02, 0.1, z);
  };
  const out: Prim[] = [skirt(1.0, 0.19, 0.3, 0.1, 0.01, 17, 0.012, 0.035, Lab.Cloth, cats)];
  // The free leg's thigh and knee under the cloth.
  const s = freeRight ? -1 : 1, th = freeRight ? R_THIGH : L_THIGH, sh = freeRight ? R_SHIN : L_SHIN;
  out.push(C(th, mir(HIP, s), mir(KNEE, s), 0.1, 0.075, Lab.Cloth, B, 0.06));
  out.push(C(sh, mir(KNEE, s), lerp3(mir(KNEE, s), mir(ANKLE, s), 0.55), 0.075, 0.07, Lab.Cloth, B, 0.06));
  // The wrap: folds run down diagonally from the left shoulder.
  const wrap = ellipsoid([0, 1.21, -0.004], [0.17, 0.21, 0.125]);
  const clip = (x: number, y: number): number => (x + 0.15) * -0.75 + (y - 1.22) * 0.66;
  out.push(P(CHEST, (x, y, z) => Math.max(wrap(x, y, z) - 0.016 * ridge((x * 0.6 - y * 0.8) * 85), clip(x, y)), [0, 1.2, 0], 0.25, Lab.Cloth, B, 0.03));
  // The tunic under it, seen on the right shoulder, with its short sleeve.
  out.push(E(CHEST, [0, 1.24, -0.005], [0.158, 0.19, 0.115], Lab.Cloth, B, 0.03));
  out.push(C(R_ARM, mir(SHOULDER, -1), lerp3(mir(SHOULDER, -1), mir(ELBOW, -1), 0.45), 0.062, 0.055, Lab.Cloth, B, 0.02));
  // Over the left shoulder and down the left arm, the forearm wrapped.
  out.push(E(CHEST, [0.13, 1.38, -0.005], [0.1, 0.09, 0.13], Lab.Cloth, B, 0.04));
  out.push(C(L_ARM, mir(SHOULDER, 1), mir(ELBOW, 1), 0.072, 0.066, Lab.Cloth, B, 0.03));
  out.push(C(L_FORE, mir(ELBOW, 1), lerp3(mir(ELBOW, 1), mir(WRIST, 1), 0.8), 0.066, 0.052, Lab.Cloth, B, 0.03));
  // The end hanging straight down from the forearm, in long folds.
  const fa = jointAt(bones, L_FORE, lerp3(mir(ELBOW, 1), mir(WRIST, 1), 0.45));
  const hang = cone(fa, [fa[0] + 0.01, Math.max(0.15, fa[1] - 0.62), fa[2] + 0.02], 0.05, 0.1);
  out.push(P(WORLD, (x, y, z) => Math.max(hang(x, y, z) - 0.018 * ridge(Math.atan2(x - fa[0], z - fa[2]) * 7 + y * 3), -y), lerp3(fa, [fa[0], fa[1] - 0.62, fa[2]], 0.5), 0.45, Lab.Cloth, B, 0.04));
  // Balteus and sinus: the praetexta's purple runs along their edges.
  out.push(...chain(CHEST, [[0.13, 1.43, 0.07], [0.02, 1.3, 0.15], [-0.1, 1.15, 0.155], [-0.19, 1.04, 0.12]], [0.03, 0.036, 0.038, 0.04], Lab.Balteus, B, 0.03));
  out.push(...chain(PELVIS, [[-0.2, 1.0, 0.1], [-0.16, 0.76, 0.19], [-0.03, 0.63, 0.215], [0.1, 0.7, 0.2], [0.19, 0.9, 0.14]], [0.042, 0.05, 0.05, 0.046, 0.04], Lab.Sinus, B, 0.035));
  out.push(E(PELVIS, [0.02, 1.04, 0.15], [0.06, 0.05, 0.045], Lab.Cloth, B, 0.03));
  return out;
}

/**
 * Armour of an officer (Holconius Rufus, the riders): a muscled cuirass with
 * its flared hem, two rows of leather strips over a short tunic, and the
 * paludamentum over the left shoulder, down the back in deep folds and
 * wrapped round the left forearm, its end hanging.
 */
function cuirassPrims(bones: Float32Array, seated: boolean): Prim[] {
  const B = Reg.Body;
  const out: Prim[] = [
    E(CHEST, [0, 1.205, 0.0], [0.158, 0.2, 0.122], Lab.Metal, B, 0.025),
    E(CHEST, [0, 0.995, 0.0], [0.17, 0.032, 0.13], Lab.Metal, B, 0.015),
  ];
  for (const s of [1, -1]) {
    out.push(E(CHEST, [0.068 * s, 1.285, 0.088], [0.072, 0.052, 0.042], Lab.Metal, B, 0.02));
    for (const y of [1.15, 1.09, 1.03]) out.push(E(CHEST, [0.036 * s, y, 0.115], [0.031, 0.024, 0.02], Lab.Metal, B, 0.01));
    out.push(C(CHEST, [0.12 * s, 1.435, 0.09], [0.12 * s, 1.445, -0.08], 0.022, 0.022, Lab.Leather, B, 0.01));
  }
  // Pteruges in two staggered rows, flat strips round the hips.
  for (let row = 0; row < 2; row++) for (let k = 0; k < 14; k++) {
    const th = ((k + row * 0.5) / 14) * Math.PI * 2, sn = Math.sin(th), cs = Math.cos(th);
    const y0 = 0.98 - row * 0.07, y1 = seated ? y0 - 0.1 : y0 - 0.17;
    const c: V3 = [0.17 * sn, (y0 + y1) / 2, 0.13 * cs];
    out.push(P(PELVIS, (x, y, z) => {
      const u = (x - c[0]) * cs - (z - c[2]) * sn, v = (x - c[0]) * sn + (z - c[2]) * cs;
      const qx = Math.abs(u) - 0.022, qy = Math.abs(y - c[1]) - (y0 - y1) / 2, qz = Math.abs(v - (c[1] - y) * 0.15) - 0.006;
      return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - 0.003;
    }, c, 0.12, Lab.Leather, B, 0.004));
  }
  if (!seated) out.push(skirt(0.92, 0.17, 0.235, 0.58, 0.56, 13, 0.01, 0.025, Lab.Cloth));
  // The cloak: bunched on the left shoulder, a shell down the back in deep folds.
  out.push(E(CHEST, [0.15, 1.42, -0.01], [0.09, 0.065, 0.12], Lab.Cloak, B, 0.03));
  const R0 = 0.205, bottom = seated ? 1.0 : 0.55;
  out.push(P(CHEST, (x, y, z) => {
    const r = Math.hypot(x, (z + 0.01) * 1.25);
    const a = Math.atan2(x, -z);
    const shell = Math.abs(r - R0 - 0.025 * ridge(a * 11 + y * 2.5) * smooth(1.35, 1.0, y)) - 0.012;
    return Math.max(shell, z - 0.03, y - 1.45, bottom + 0.06 * Math.cos(a * 2) - y);
  }, [0, (1.45 + bottom) / 2, -0.1], 0.55, Lab.Cloak, B, 0.02));
  out.push(C(L_FORE, mir(ELBOW, 1), lerp3(mir(ELBOW, 1), mir(WRIST, 1), 0.8), 0.062, 0.05, Lab.Cloak, B, 0.025));
  const fa = jointAt(bones, L_FORE, lerp3(mir(ELBOW, 1), mir(WRIST, 1), 0.5));
  const hang = cone(fa, [fa[0], fa[1] - (seated ? 0.35 : 0.55), fa[2] + 0.02], 0.045, 0.085);
  out.push(P(WORLD, (x, y, z) => hang(x, y, z) - 0.015 * ridge(Math.atan2(x - fa[0], z - fa[2]) * 6 + y * 4), [fa[0], fa[1] - 0.3, fa[2]], 0.4, Lab.Cloak, B, 0.03));
  return out;
}

/** A belted chiton with sleeves, as Diana wears it (her bust), and her quiver strap. */
function chitonPrims(): Prim[] {
  const B = Reg.Body;
  const top = ellipsoid([0, 1.22, -0.003], [0.162, 0.21, 0.118]);
  return [
    P(CHEST, (x, y, z) => top(x, y, z) - 0.009 * ridge(Math.atan2(x, z) * 18 + y * 20), [0, 1.22, 0], 0.25, Lab.Cloth, B, 0.03),
    ...chain(CHEST, [[0.11, 1.43, 0.06], [-0.02, 1.3, 0.12], [-0.14, 1.15, 0.09]], [0.012, 0.012, 0.012], Lab.Leather, B, 0.008),
  ];
}

// --- poses -----------------------------------------------------------------------------

/** Contrapposto: the weight on one leg, its hip high, the other foot drawn back and out, the shoulders tilted the other way. */
function stance(weightRight: boolean, out: number, back: number, lift: number): { hip: V3; pelvis: [number, number, number]; feet: [FootPose, FootPose] } {
  const s = weightRight ? 1 : -1;
  const planted: FootPose = { ankle: ankleFrom([-0.08 * s, 0, 0.0], HEEL_Z, 0, -s), pitch: 0 };
  const free: FootPose = { ankle: ankleFrom([(0.1 + out) * s, 0, -back + BALL_Z - HEEL_Z], BALL_Z, -lift, s), pitch: -lift };
  const pelvis: [number, number, number] = [0.08 * s, 0.01, -0.09 * s];
  const dx = -0.045 * s;
  const feet: [FootPose, FootPose] = weightRight ? [free, planted] : [planted, free];
  return { hip: [dx, hipLift(pelvis, dx, feet, -0.01) - 0.004, 0], pelvis, feet };
}

export type StatueKind = "togate" | "cuirassed" | "rider" | "apollo" | "diana" | "doryphoros" | "faun" | "lampbearer" | "boy" | "satyr" | "herm" | "horse";

/** A statue's prims in their pose, and the grids its regions are meshed at (metres at life size). */
interface Design { bones: Float32Array; prims: Prim[]; marble: boolean; bustY?: number; grids: [number, number][] }

const HERO: [number, number][] = [[Reg.Body, 0.025], [Reg.Head, 0.009], [Reg.HandL, 0.007], [Reg.HandR, 0.007], [Reg.FootL, 0.011], [Reg.FootR, 0.011]];
/** Garden pieces stand under a metre: the same detail on screen at coarser grids of their life-size field. */
const SMALL: [number, number][] = [[Reg.Body, 0.048], [Reg.Head, 0.018], [Reg.HandL, 0.014], [Reg.HandR, 0.014], [Reg.FootL, 0.022], [Reg.FootR, 0.022]];

function figureDesign(build: Build, pose: PoseSpec, dress: (bones: Float32Array) => Prim[], marble: boolean, grids = HERO, bustY?: number): Design {
  const bones = solvePose(pose);
  return { bones, prims: [...bodyPrims(build), ...dress(bones)], marble, bustY, grids };
}

function design(kind: StatueKind, tray?: V3): Design {
  switch (kind) {
    case "togate": {
      // An orator (the Arringatore's gesture): weight on the left leg, the
      // right arm raised with the hand open, the left holding a scroll in the toga's fold.
      const st = stance(false, 0.03, 0.1, 0.18);
      return figureDesign({ mass: 1.05, hair: "locks", hands: ["grip", "open"], shoes: true },
        { ...st, chest: [0.06, 0.02, -0.04], head: [-0.15, 0.04, 0.02], wrists: [armAt(1, 0.3, 0.1, 1.2), [-0.34, 1.45, 0.32]], poles: [[0.3, -0.3, -1], [-1, -0.6, -0.3]], handBend: [0.2, -0.8] },
        (bones) => [...togaPrims(bones, true), ...scrollPrims(bones)], false);
    }
    case "cuirassed": {
      const st = stance(true, 0.03, 0.1, 0.18);
      return figureDesign({ mass: 1.1, hair: "locks", hands: ["grip", "open"], shoes: true },
        { ...st, chest: [-0.06, 0, 0.04], head: [0.2, 0.0, 0.0], wrists: [armAt(1, 0.3, 0.12, 1.3), [-0.38, 1.25, 0.3]], poles: [[0.3, -0.3, -1], [-1, -0.8, -0.2]], handBend: [0, -0.5] },
        (bones) => cuirassPrims(bones, false), true);
    }
    case "rider": {
      // Astride without stirrups, the legs hanging long down the horse's
      // sides, the reins in the left hand, the right arm out in address.
      const feet: [FootPose, FootPose] = [{ ankle: [0.33, 0.18, 0.14], pitch: -0.6 }, { ankle: [-0.33, 0.18, 0.14], pitch: -0.6 }];
      return figureDesign({ mass: 1.1, hair: "locks", hands: ["grip", "open"], shoes: true },
        { hip: [0, 0, 0], pelvis: [0, 0.05, 0], feet, chest: [0, 0.04, 0], head: [0.15, 0.0, 0], wrists: [[0.12, 1.05, 0.38], [-0.32, 1.48, 0.52]], poles: [[0.5, -0.5, -1], [-1, -0.4, -0.3]], handBend: [0, -0.5] },
        (bones) => cuirassPrims(bones, true), false);
    }
    case "apollo": {
      const st = stance(false, 0.04, 0.12, 0.25);
      return figureDesign({ mass: 1.0, hair: "knot", hands: ["grip", "relaxed"], nude: true },
        { ...st, chest: [0.35, 0.0, -0.03], head: [0.45, -0.04, 0.03], wrists: [[0.52, 1.36, 0.36], [0.02, 1.33, 0.2]], poles: [[0.4, -1, -0.4], [-1, -0.4, -0.8]], handBend: [0, 0.4] },
        (bones) => bowPrims(bones), false);
    }
    case "diana":
      return figureDesign({ mass: 0.9, woman: true, hair: "knot", hands: ["relaxed", "relaxed"] },
        { hip: [0, 0, 0], pelvis: [0, 0, 0], chest: [0.1, 0, 0], head: [-0.25, 0.04, 0], feet: [{ ankle: ankleFrom([0.08, 0, 0], HEEL_Z, 0, 1), pitch: 0 }, { ankle: ankleFrom([-0.08, 0, 0], HEEL_Z, 0, -1), pitch: 0 }], wrists: [armAt(1, 0, 0.05, 0.2), armAt(-1, 0, 0.05, 0.2)], poles: [[0.3, 0, -1], [-0.3, 0, -1]] },
        () => chitonPrims(), false, HERO, 1.1);
    case "doryphoros": {
      const st = stance(true, 0.04, 0.2, 0.55);
      return figureDesign({ mass: 1.18, hair: "locks", hands: ["grip", "relaxed"], nude: true },
        { ...st, chest: [-0.14, 0.02, 0.07], head: [0.3, 0.12, 0.02], wrists: [[0.25, 1.06, 0.22], armAt(-1, 0.02, 0.05, 0.1)], poles: [[0.3, -0.3, -1], [-0.3, 0, -1]], handBend: [0.6, 0] },
        (bones) => spearPrims(bones), true);
    }
    case "faun": {
      // On the balls of his feet, turning: hips one way, shoulders hard the other, head thrown back.
      const lp = -0.75, rp = -0.6;
      return figureDesign({ mass: 1.12, faun: true, hair: "curls", hands: ["spread", "spread"], nude: true },
        {
          hip: [0.03, -0.04, -0.01], pelvis: [0.38, -0.05, 0.08], chest: [-0.75, -0.18, -0.1], head: [-0.35, -0.5, -0.15],
          feet: [{ ankle: ankleFrom([0.2, 0, 0.12 + BALL_Z - HEEL_Z], BALL_Z, lp, 1), pitch: lp }, { ankle: ankleFrom([-0.1, 0, -0.12 + BALL_Z - HEEL_Z], BALL_Z, rp, -1), pitch: rp }],
          wrists: [[0.6, 1.52, 0.2], [-0.33, 1.87, 0.08]], poles: [[0.2, -1, -0.6], [-1, -0.3, -0.4]], handBend: [0.5, 0.4],
        }, () => [], false);
    }
    case "lampbearer": {
      const st = stance(true, 0.0, 0.1, 0.22);
      const t = tray ?? [0.44, 1.58, 0.23];
      return figureDesign({ mass: 0.98, hair: "curls", hands: ["open", "relaxed"], nude: true },
        { ...st, chest: [-0.12, 0.02, 0.07], head: [0.3, 0.12, 0.04], wrists: [[t[0] - 0.02, t[1] - 0.09, t[2] - 0.03], armAt(-1, 0.05, 0.06, 0.2)], poles: [[1, -0.8, -0.3], [-0.35, -0.2, -1]], handBend: [-0.9, 0] },
        () => [], false);
    }
    case "boy": {
      // A garden bronze: a chubby boy hugging a goose to his left side.
      const st = stance(true, 0.02, 0.08, 0.2);
      return figureDesign({ mass: 1.3, child: true, hair: "curls", hands: ["grip", "grip"], nude: true },
        { ...st, chest: [0.25, 0.04, 0.05], head: [-0.4, 0.15, 0.08], wrists: [[0.2, 1.08, 0.2], [0.05, 1.12, 0.24]], poles: [[0.6, -0.5, -0.6], [-0.6, -0.5, -0.6]] },
        (bones) => goosePrims(bones), false, SMALL);
    }
    case "satyr": {
      // A small satyr tipping back a wineskin.
      const st = stance(false, 0.05, 0.12, 0.3);
      return figureDesign({ mass: 1.08, faun: true, hair: "curls", hands: ["grip", "relaxed"], nude: true },
        { ...st, chest: [0.2, -0.12, -0.05], head: [0.1, -0.4, 0.05], wrists: [[0.12, 1.7, 0.15], armAt(-1, 0.1, 0.15, 0.4)], poles: [[1, -0.3, -0.3], [-0.3, 0, -1]] },
        (bones) => wineskinPrims(bones), false, SMALL);
    }
    case "herm": {
      // A bearded herm: the head on a square shaft, stubs for arms.
      const bones = solvePose({ hip: [0, 0, 0], pelvis: [0, 0, 0], chest: [0, 0, 0], head: [0, 0.05, 0], feet: [{ ankle: ankleFrom([0.08, 0, 0], HEEL_Z, 0, 1), pitch: 0 }, { ankle: ankleFrom([-0.08, 0, 0], HEEL_Z, 0, -1), pitch: 0 }], wrists: [armAt(1, 0, 0.05, 0.2), armAt(-1, 0, 0.05, 0.2)], poles: [[0.3, 0, -1], [-0.3, 0, -1]] });
      const shaft: F = (x, y, z) => {
        const hw = 0.11 - 0.025 * (1.4 - y) / 1.4, qx = Math.abs(x) - hw, qy = Math.abs(y - 0.72) - 0.72, qz = Math.abs(z) - hw * 0.85;
        return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - 0.004;
      };
      const prims: Prim[] = [P(WORLD, shaft, [0, 0.72, 0], 0.8, Lab.Skin, Reg.Body, 0.01),
        C(WORLD, [-0.19, 1.36, -0.01], [0.19, 1.36, -0.01], 0.035, 0.035, Lab.Skin, Reg.Body, 0.04),
        ...headPrims({ mass: 1, hair: "beard", hands: ["relaxed", "relaxed"] }),
        C(CHEST, [0, 1.36, -0.02], [0, 1.52, 0.0], 0.05, 0.045, Lab.Skin, Reg.Body | Reg.Head, 0.03)];
      return { bones, prims, marble: true, grids: SMALL };
    }
    case "horse": return horseDesign();
  }
}

/** Posed joints for world-space props. */
function jointAt(bones: Float32Array, bone: number, p: V3): V3 {
  const m = bones.subarray(bone * 16, bone * 16 + 16);
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
/** The middle of a hand's grip, world space. */
const gripAt = (bones: Float32Array, s: number): V3 => jointAt(bones, s > 0 ? L_HAND : R_HAND, add(mir(WRIST, s), [-0.02 * s, -0.075, 0.01]));

/** Apollo's bow: a recurved stave through the left hand, held upright. */
function bowPrims(bones: Float32Array): Prim[] {
  const g = gripAt(bones, 1);
  const pts: V3[] = [-0.55, -0.4, -0.2, 0, 0.2, 0.4, 0.55].map((t): V3 => [g[0] + 0.05 * (1 - (2 * t) ** 2) + (Math.abs(t) > 0.45 ? -0.03 : 0), g[1] + t, g[2] + 0.04 * (1 - (2 * t) ** 2)]);
  return chain(WORLD, pts, [0.006, 0.009, 0.012, 0.014, 0.012, 0.009, 0.006], Lab.Wood, Reg.Prop, 0.005);
}

/** The Doryphoros's spear, over the left shoulder from the left hand. */
function spearPrims(bones: Float32Array): Prim[] {
  const g = gripAt(bones, 1), dir: V3 = [-0.1, 0.92, -0.38];
  return [C(WORLD, add(g, scl(dir, -0.5)), add(g, scl(dir, 1.6)), 0.014, 0.012, Lab.Wood, Reg.Prop, 0.004)];
}

/** A rolled scroll in the orator's left hand. */
function scrollPrims(bones: Float32Array): Prim[] {
  const g = gripAt(bones, 1);
  return [C(WORLD, add(g, [0, -0.11, 0.02]), add(g, [0, 0.11, -0.02]), 0.02, 0.02, Lab.Cloth, Reg.HandL, 0.004)];
}

/** The goose in the boy's arms: body, long neck, head and bill. */
function goosePrims(bones: Float32Array): Prim[] {
  const g = lerp3(gripAt(bones, 1), gripAt(bones, -1), 0.5);
  const c: V3 = add(g, [0.06, 0.02, 0.09]);
  return [
    E(WORLD, c, [0.1, 0.085, 0.16], Lab.Skin, Reg.Body, 0.02),
    ...chain(WORLD, [add(c, [0.02, 0.04, 0.13]), add(c, [0.0, 0.16, 0.2]), add(c, [-0.04, 0.27, 0.18])], [0.03, 0.022, 0.02], Lab.Skin, Reg.Body, 0.02),
    E(WORLD, add(c, [-0.05, 0.29, 0.2]), [0.032, 0.03, 0.045], Lab.Skin, Reg.Body, 0.012),
    C(WORLD, add(c, [-0.06, 0.285, 0.24]), add(c, [-0.07, 0.275, 0.3]), 0.012, 0.005, Lab.Skin, Reg.Body, 0.006),
  ];
}

/** A wineskin lifted to the satyr's mouth. */
function wineskinPrims(bones: Float32Array): Prim[] {
  const g = gripAt(bones, 1);
  return [E(WORLD, add(g, [0.03, -0.08, 0.05]), [0.07, 0.11, 0.07], Lab.Leather, Reg.Body, 0.02)];
}

// --- the horse -------------------------------------------------------------------------

/**
 * The equestrian bronze's horse, sculpted on render/horse.ts's skeleton in a
 * collected walk with the near fore raised: the barrel, a deep chest, the
 * shoulder and haunch masses, the neck arched with its crest and the mane
 * in locks, a lean head with jaw, nostrils and pricked ears, legs with the
 * knee, the tendon behind the cannon, fetlocks and hooves; the saddle
 * cloth and the tail.
 */
function horseDesign(): Design {
  const bones = new Float32Array(HORSE_BONES * 16);
  poseHorse("walk", 0.84, bones, 1);
  const out: Prim[] = [];
  const B = Reg.Body, Hd = Reg.Head, Lg = Reg.FootL;
  out.push(E(0, [0, 1.12, -0.06], [0.29, 0.31, 0.72], Lab.Skin, B, 0.08));
  out.push(E(0, [0, 1.04, 0.5], [0.23, 0.31, 0.24], Lab.Skin, B, 0.08));
  out.push(E(0, [0, 0.93, 0.0], [0.25, 0.14, 0.42], Lab.Skin, B, 0.08));
  out.push(E(0, [0, 1.41, 0.3], [0.08, 0.07, 0.17], Lab.Skin, B, 0.06));
  out.push(E(0, [0, 1.34, -0.55], [0.21, 0.11, 0.26], Lab.Skin, B, 0.07));
  for (const s of [1, -1]) {
    out.push(E(0, [0.17 * s, 1.13, 0.42], [0.11, 0.27, 0.17], Lab.Skin, B, 0.06));
    out.push(E(0, [0.18 * s, 1.18, -0.57], [0.13, 0.26, 0.25], Lab.Skin, B, 0.07));
  }
  // The neck along its arch, deep at the base, the crest above it, the mane in locks.
  const bz = (a: V3, b: V3, c: V3, t: number): V3 => [0, 1, 2].map((k) => (1 - t) * (1 - t) * a[k] + 2 * (1 - t) * t * b[k] + t * t * c[k]) as V3;
  const np = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => bz(NECK.base, NECK.ctrl, NECK.poll, t));
  out.push(...chain(1, np, [0.22, 0.19, 0.15, 0.12, 0.1, 0.09], Lab.Skin, B, 0.07));
  out.push(...chain(1, np.slice(1).map((p, i) => add(p, [0, 0.12 - i * 0.015, -0.03])), [0.05, 0.055, 0.05, 0.045, 0.035], Lab.Skin, B, 0.05));
  for (let i = 0; i < 9; i++) {
    const t = 0.12 + i * 0.1, p = bz(NECK.base, NECK.ctrl, NECK.poll, t);
    const top: V3 = add(p, [0.01, 0.15 - t * 0.06, -0.02]);
    out.push(C(1, top, add(top, [0.07, -0.16, -0.02]), 0.022, 0.01, Lab.Hair, B, 0.015));
  }
  // The head: skull, cheeks and jaw, the long face to the muzzle, nostrils, eyes, ears, forelock.
  const ax = norm3(sub(HORSE_HEAD.muzzle, HORSE_HEAD.poll)), hp = (t: number, up = 0): V3 => add(add(HORSE_HEAD.poll, scl(ax, t * 0.6)), [0, up * 0.9, up * 0.4]);
  out.push(E(2, hp(0.12, 0.02), [0.09, 0.1, 0.1], Lab.Skin, Hd, 0.04));
  out.push(C(2, hp(0.15), hp(0.95), 0.085, 0.06, Lab.Skin, Hd, 0.04));
  out.push(E(2, hp(1.0, -0.01), [0.063, 0.07, 0.068], Lab.Skin, Hd, 0.03));
  for (const s of [1, -1]) {
    out.push(E(2, add(hp(0.3, -0.06), [0.06 * s, 0, 0]), [0.035, 0.08, 0.09], Lab.Skin, Hd, 0.03));
    out.push(P(2, sphere(add(hp(1.02, 0.0), [0.032 * s, 0.0, 0.02]), 0.017), add(hp(1.02, 0), [0.032 * s, 0, 0.02]), 0.02, Lab.Skin, Hd, 0.01, true));
    out.push(E(2, add(hp(0.28, 0.04), [0.085 * s, 0, 0]), [0.012, 0.018, 0.02], Lab.Eye, Hd, 0.008));
    out.push(C(2, add(HORSE_HEAD.poll, [0.055 * s, 0.07, -0.01]), add(HORSE_HEAD.poll, [0.075 * s, 0.22, 0.03]), 0.028, 0.005, Lab.Skin, Hd, 0.015));
  }
  out.push(C(2, hp(0.02, 0.1), hp(0.22, 0.04), 0.025, 0.012, Lab.Hair, Hd, 0.01));
  // Tail: the dock, then the hair in locks falling to the hocks.
  out.push(...chain(3, [[0, 1.36, -0.83], [0, 1.3, -0.93], [0, 1.1, -0.98], [0, 0.85, -0.98], [0, 0.62, -0.94]], [0.06, 0.06, 0.08, 0.075, 0.04], Lab.Hair, B, 0.04));
  // Legs: the forearm or gaskin's muscle, the knee or hock, cannon with the tendon behind it, fetlock, pastern, hoof.
  LEGS.forEach((L, li) => {
    const bone = 4 + li * 3;
    out.push(C(bone, L.pivot, L.mid, L.fore ? 0.1 : 0.12, 0.055, Lab.Skin, B, 0.05));
    out.push(E(bone, lerp3(L.pivot, L.mid, 0.3), L.fore ? [0.075, 0.16, 0.08] : [0.09, 0.2, 0.12], Lab.Skin, B, 0.05));
    out.push(E(bone + 1, L.mid, [0.055, 0.06, 0.055], Lab.Skin, B | Lg, 0.03));
    out.push(C(bone + 1, L.mid, L.fet, 0.042, 0.037, Lab.Skin, Lg, 0.02));
    out.push(C(bone + 1, add(L.mid, [0, -0.03, -0.035]), add(L.fet, [0, 0.03, -0.035]), 0.017, 0.016, Lab.Skin, Lg, 0.02));
    out.push(E(bone + 2, L.fet, [0.048, 0.05, 0.05], Lab.Skin, Lg, 0.02));
    const coronet: V3 = [L.toe[0], 0.07, L.toe[2] - 0.03];
    out.push(C(bone + 2, L.fet, coronet, 0.04, 0.045, Lab.Skin, Lg, 0.015));
    const hoof = cone(coronet, [L.toe[0], 0.0, L.toe[2] - 0.01], 0.05, 0.065);
    out.push(P(bone + 2, (x, y, z) => Math.max(hoof(x, y, z), -y), coronet, 0.1, Lab.Hair, Lg, 0.01));
  });
  // The saddle cloth over the back, its edge hanging below the line of the barrel's top.
  const cloth = ellipsoid([0, 1.13, 0.02], [0.315, 0.335, 0.34]);
  out.push(P(0, (x, y, z) => Math.max(Math.abs(cloth(x, y, z)) - 0.012, 1.18 - y + 0.02 * Math.sin(z * 40), Math.abs(z - 0.02) - 0.3), [0, 1.35, 0.02], 0.4, Lab.Cloak, B, 0.01));
  return { bones, prims: out, marble: false, grids: [[B, 0.034], [Hd, 0.014], [Lg, 0.016]] };
}

/** Bridle straps (noseband, cheek pieces, browband) as tubes on the posed horse, and where the bit is. */
function bridle(bones: Float32Array): { tubes: [V3, V3, number, number][]; bit: [V3, V3] } {
  const ax = norm3(sub(HORSE_HEAD.muzzle, HORSE_HEAD.poll)), hp = (t: number, up = 0, x = 0): V3 => add(add(HORSE_HEAD.poll, scl(ax, t * 0.6)), [x, up * 0.9, up * 0.4]);
  const J = (p: V3): V3 => jointAt(bones, 2, p);
  const tubes: [V3, V3, number, number][] = [];
  const ring = (t: number, up: number, rx: number, ry: number): void => {
    const pts: V3[] = [];
    for (let k = 0; k <= 10; k++) { const a = (k / 10) * Math.PI * 2; pts.push(J(hp(t, up + ry * Math.sin(a), rx * Math.cos(a)))); }
    for (let k = 0; k < 10; k++) tubes.push([pts[k], pts[k + 1], 0.008, 0.008]);
  };
  ring(0.82, -0.005, 0.075, 0.075);
  ring(0.08, 0.04, 0.1, 0.11);
  for (const s of [1, -1]) tubes.push([J(hp(0.1, 0.0, 0.09 * s)), J(hp(0.85, -0.03, 0.07 * s)), 0.008, 0.008]);
  return { tubes, bit: [J(hp(0.92, -0.05, 0.07)), J(hp(0.92, -0.05, -0.07))] };
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
  private readonly allAdds: Placed[];
  private readonly allSubs: Placed[];
  private adds: Placed[];
  private subs: Placed[];
  lab = 0;
  /**
   * Evaluate only the primitives that can reach a box (grown by `margin`):
   * a figure is a hundred of them and any one point is near a handful, so
   * this is most of the mesher's speed. Without a box, all of them.
   */
  focus(lo?: V3, hi?: V3, margin = 0): void {
    if (!lo || !hi) { this.adds = this.allAdds; this.subs = this.allSubs; return; }
    const near = (q: Placed): boolean => {
      const dx = Math.max(lo[0] - q.cx, 0, q.cx - hi[0]), dy = Math.max(lo[1] - q.cy, 0, q.cy - hi[1]), dz = Math.max(lo[2] - q.cz, 0, q.cz - hi[2]);
      return len3(dx, dy, dz) <= q.p.r + q.p.k + margin;
    };
    this.adds = this.allAdds.filter(near);
    this.subs = this.allSubs.filter(near);
    if (!this.adds.length) this.adds = this.allAdds;
  }
  constructor(prims: Prim[], bones: Float32Array, private readonly clipY: number) {
    const place = (p: Prim): Placed => {
      if (p.bone === WORLD) return { p, inv: null, cx: p.c[0], cy: p.c[1], cz: p.c[2] };
      const c = jointAt(bones, p.bone, p.c);
      return { p, inv: invert(bones.subarray(p.bone * 16, p.bone * 16 + 16)), cx: c[0], cy: c[1], cz: c[2] };
    };
    this.adds = this.allAdds = prims.filter((p) => !p.sub).map(place);
    this.subs = this.allSubs = prims.filter((p) => p.sub).map(place);
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

export interface StatueMesh { position: number[]; normal: number[]; colour: number[]; index: number[]; thin: number[] }

/** Surface nets over a box at spacing h: one vertex per cell the surface crosses, quads across crossing edges. */
function polygonise(F: Field, lo: V3, hi: V3, h: number, out: StatueMesh, paint: (lab: number, p: V3, n: V3, F: Field) => RGB): void {
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
  const V = new Float32Array(nx * ny * nz);
  const id = (i: number, j: number, k: number): number => (k * ny + j) * nx + i;
  // A narrow band: the field is sampled on a grid four cells apart first,
  // and only the blocks the surface can reach are sampled finely; the rest
  // take the sign of their corners, which is all the mesher reads there.
  const Bk = 4, bx = Math.ceil((nx - 1) / Bk), by = Math.ceil((ny - 1) / Bk), bz = Math.ceil((nz - 1) / Bk);
  const C = new Float32Array((bx + 1) * (by + 1) * (bz + 1));
  const cidx = (i: number, j: number, k: number): number => (k * (by + 1) + j) * (bx + 1) + i;
  for (let k = 0; k <= bz; k++) for (let j = 0; j <= by; j++) for (let i = 0; i <= bx; i++) C[cidx(i, j, k)] = F.at(lo[0] + i * Bk * h, lo[1] + j * Bk * h, lo[2] + k * Bk * h);
  const reach = Bk * h * 1.8;
  const active = new Uint8Array(bx * by * bz);
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
    let near = false;
    for (let c = 0; c < 8 && !near; c++) near = Math.abs(C[cidx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]) < reach;
    if (near) active[(k * by + j) * bx + i] = 1;
  }
  const rnd = (n: number): Int32Array => { const a = new Int32Array(n); for (let q = 0; q < n; q++) a[q] = Math.round(q / Bk); return a; };
  const rx = rnd(nx), ry = rnd(ny), rz = rnd(nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) V[id(i, j, k)] = C[cidx(rx[i], ry[j], rz[k])];
  // Only the blocks near the surface can hold a sign change: the cells and quads are looked for there alone.
  const onBlocks: [number, number, number][] = [];
  // Fine samples block by block, each block with only the primitives near it.
  for (let ck = 0; ck < bz; ck++) for (let cj = 0; cj < by; cj++) for (let ci = 0; ci < bx; ci++) {
    let on = false;
    for (let dk = -1; dk <= 1 && !on; dk++) for (let dj = -1; dj <= 1 && !on; dj++) for (let di = -1; di <= 1 && !on; di++) {
      const a = ci + di, b = cj + dj, c = ck + dk;
      if (a >= 0 && b >= 0 && c >= 0 && a < bx && b < by && c < bz && active[(c * by + b) * bx + a]) on = true;
    }
    if (!on) continue;
    onBlocks.push([ci, cj, ck]);
    const blo: V3 = [lo[0] + ci * Bk * h, lo[1] + cj * Bk * h, lo[2] + ck * Bk * h];
    F.focus(blo, add(blo, [Bk * h, Bk * h, Bk * h]), reach);
    for (let k = ck * Bk; k <= Math.min(nz - 1, (ck + 1) * Bk); k++) for (let j = cj * Bk; j <= Math.min(ny - 1, (cj + 1) * Bk); j++) for (let i = ci * Bk; i <= Math.min(nx - 1, (ci + 1) * Bk); i++) {
      V[id(i, j, k)] = F.at(lo[0] + i * h, lo[1] + j * h, lo[2] + k * h);
    }
  }
  const cell = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number): number => (k * (ny - 1) + j) * (nx - 1) + i;
  const E: [number, number, number, number, number, number][] = [
    [0, 0, 0, 1, 0, 0], [0, 1, 0, 1, 1, 0], [0, 0, 1, 1, 0, 1], [0, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0], [0, 0, 1, 0, 1, 1], [1, 0, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [0, 1, 0, 0, 1, 1], [1, 1, 0, 1, 1, 1],
  ];
  const base = out.position.length / 3;
  let nv = 0;
  const inBlocks = (lo0: number, cb: (i: number, j: number, k: number) => void, hiPad: number): void => {
    for (const [ci, cj, ck] of onBlocks) {
      for (let k = Math.max(lo0, ck * Bk); k < Math.min(nz - hiPad, (ck + 1) * Bk); k++) for (let j = Math.max(lo0, cj * Bk); j < Math.min(ny - hiPad, (cj + 1) * Bk); j++) for (let i = Math.max(lo0, ci * Bk); i < Math.min(nx - hiPad, (ci + 1) * Bk); i++) cb(i, j, k);
    }
  };
  inBlocks(0, (i, j, k) => {
    const s0 = V[id(i, j, k)] < 0;
    if (s0 === (V[id(i + 1, j, k)] < 0) && s0 === (V[id(i, j + 1, k)] < 0) && s0 === (V[id(i + 1, j + 1, k)] < 0) && s0 === (V[id(i, j, k + 1)] < 0) && s0 === (V[id(i + 1, j, k + 1)] < 0) && s0 === (V[id(i, j + 1, k + 1)] < 0) && s0 === (V[id(i + 1, j + 1, k + 1)] < 0)) return;
    let sx = 0, sy = 0, sz = 0, c = 0;
    for (const [a0, a1, a2, b0, b1, b2] of E) {
      const va = V[id(i + a0, j + a1, k + a2)], vb = V[id(i + b0, j + b1, k + b2)];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += a0 + (b0 - a0) * t; sy += a1 + (b1 - a1) * t; sz += a2 + (b2 - a2) * t; c++;
    }
    if (!c) return;
    const p: V3 = [lo[0] + (i + sx / c) * h, lo[1] + (j + sy / c) * h, lo[2] + (k + sz / c) * h];
    F.focus(p, p, 0.12);
    const e = h * 0.35;
    let n: V3 = [F.at(p[0] + e, p[1], p[2]) - F.at(p[0] - e, p[1], p[2]), F.at(p[0], p[1] + e, p[2]) - F.at(p[0], p[1] - e, p[2]), F.at(p[0], p[1], p[2] + e) - F.at(p[0], p[1], p[2] - e)];
    const L = len3(...n) || 1;
    n = [n[0] / L, n[1] / L, n[2] / L];
    F.at(p[0], p[1], p[2]);
    const col = paint(F.lab, p, n, F);
    out.position.push(...p); out.normal.push(...n); out.colour.push(...col); out.thin.push(thinness(p, n, F, 0.025));
    cell[cid(i, j, k)] = base + nv++;
  }, 1);
  // Quads: each grid edge with a sign change joins the four cells round it.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) out.index.push(a, c, b, a, d, c); else out.index.push(a, b, c, a, c, d);
  };
  inBlocks(1, (i, j, k) => {
    const v0 = V[id(i, j, k)] < 0;
    if (i < nx - 1 && v0 !== (V[id(i + 1, j, k)] < 0)) quad(cell[cid(i, j - 1, k - 1)], cell[cid(i, j, k - 1)], cell[cid(i, j, k)], cell[cid(i, j - 1, k)], !v0);
    if (j < ny - 1 && v0 !== (V[id(i, j + 1, k)] < 0)) quad(cell[cid(i - 1, j, k - 1)], cell[cid(i - 1, j, k)], cell[cid(i, j, k)], cell[cid(i, j, k - 1)], !v0);
    if (k < nz - 1 && v0 !== (V[id(i, j, k + 1)] < 0)) quad(cell[cid(i - 1, j - 1, k)], cell[cid(i, j - 1, k)], cell[cid(i, j, k)], cell[cid(i - 1, j, k)], !v0);
  }, 1);
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
    out.position.push(...add(end, scl(n, r))); out.normal.push(...n); out.colour.push(...c); out.thin.push(0.3);
  }
  for (let j = 0; j < m; j++) {
    const j1 = (j + 1) % m;
    out.index.push(base + j, base + j1, base + m + j1, base + j, base + m + j1, base + m + j);
  }
}

// --- materials -------------------------------------------------------------------------

const BRONZE: RGB = [0.27, 0.18, 0.1], DARK: RGB = [0.11, 0.075, 0.045], PATINA: RGB = [0.11, 0.24, 0.19], WORN: RGB = [0.56, 0.39, 0.18];
const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scl3 = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** How open a surface point is to the sky round it, 0 deep in a fold to 1 in the open, from the field itself. */
function openness(p: V3, n: V3, F: Field, e: number): number {
  const a = F.at(p[0] + n[0] * e, p[1] + n[1] * e, p[2] + n[2] * e) / e, b = F.at(p[0] + n[0] * e * 2.5, p[1] + n[1] * e * 2.5, p[2] + n[2] * e * 2.5) / (e * 2.5);
  return Math.min(1, Math.max(0, (a + b) / 2));
}
/** How thin the material is under a point (a finger, an ear, a fold's edge): 1 thin, 0 solid. */
function thinness(p: V3, n: V3, F: Field, e: number): number {
  return 1 - Math.min(1, Math.max(0, -F.at(p[0] - n[0] * e, p[1] - n[1] * e, p[2] - n[2] * e) / e));
}

/** Bronze: darker in the hollows, verdigris only in the deepest, rubbed bright where it is thin and stands out. */
function bronzePaint(p: V3, n: V3, F: Field): RGB {
  const open = openness(p, n, F, 0.03), thin = thinness(p, n, F, 0.025);
  let c = mix3(BRONZE, DARK, smooth(0.85, 0.35, open));
  c = mix3(c, PATINA, smooth(0.18, 0.04, open) * 0.8);
  return mix3(c, WORN, smooth(0.45, 0.85, thin) * 0.3);
}

/**
 * Painted marble: the flesh barely tinted, hair, eyes and lips coloured, the
 * praetexta's purple along the sinus's lower edge and the balteus's upper
 * edge (so it follows the cloth at an even width), the cloak in red.
 */
function marblePaint(lab: number, n: V3, cloak: RGB): RGB {
  const CLOTH: RGB = [0.86, 0.83, 0.76], PURPLE: RGB = [0.42, 0.11, 0.22];
  switch (lab) {
    case Lab.Hair: return [0.32, 0.2, 0.11];
    case Lab.Eye: return [0.62, 0.52, 0.44];
    case Lab.Lip: return [0.84, 0.68, 0.62];
    case Lab.Border: return PURPLE;
    case Lab.Sinus: return n[1] < -0.25 ? PURPLE : CLOTH;
    case Lab.Balteus: return n[1] > 0.35 ? PURPLE : CLOTH;
    case Lab.Cloak: return cloak;
    case Lab.Metal: return [0.8, 0.68, 0.46];
    case Lab.Leather: return [0.42, 0.25, 0.14];
    case Lab.Wood: return [0.4, 0.28, 0.16];
    case Lab.Cloth: return CLOTH;
    default: return [0.88, 0.8, 0.71];
  }
}

export interface StatueBuilt extends StatueMesh { style: number; height: number; grips: V3[]; bit?: [V3, V3] }
const cache = new Map<string, StatueBuilt>();
const ALL = Reg.Body | Reg.Head | Reg.HandL | Reg.HandR | Reg.FootL | Reg.FootR;

/**
 * A statue's mesh at life size (1.7 m figure), feet on y 0, facing +z.
 * `lean` (the reduced tier) meshes it at one coarse grid: a couple of
 * thousand triangles instead of tens of thousands.
 */
export function buildStatue(kind: StatueKind, lean: boolean, opts: { tray?: V3; marble?: boolean; tiny?: boolean } = {}): StatueBuilt {
  const key = `${kind}|${lean}|${opts.tray?.join(",") ?? ""}|${opts.marble ?? ""}|${opts.tiny ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = design(kind, opts.tray);
  const marble = opts.marble ?? d.marble;
  const { bones, prims } = d;
  const out: StatueMesh = { position: [], normal: [], colour: [], index: [], thin: [] };
  const cloak: RGB = [0.62, 0.13, 0.09];
  const paint = (lab: number, p: V3, n: V3, F: Field): RGB => (marble ? scl3(marblePaint(lab, n, cloak), 0.5 + 0.5 * openness(p, n, F, 0.03)) : bronzePaint(p, n, F));
  const regions: [number, number][] = lean ? [[ALL, opts.tiny ? 0.09 : 0.06]] : d.grids;
  // Thin props (a bow, a spear, the bridle) are tubes: a field fine enough for them would cost thousands of triangles.
  for (const p of prims) if (p.reg === Reg.Prop && p.tube) tube(out, p.tube, marble ? marblePaint(p.lab, [0, 1, 0], cloak) : p.lab === Lab.Wood ? [0.3, 0.2, 0.11] : BRONZE);
  let bit: [V3, V3] | undefined;
  if (kind === "horse") {
    const br = bridle(bones);
    for (const t of br.tubes) tube(out, t, DARK);
    bit = br.bit;
  }
  const figure = kind !== "horse" && kind !== "herm";
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
    // The head mesh need not cover the neck's far end.
    if (figure && reg === Reg.Head) lo[1] = Math.max(lo[1], jointAt(bones, HEAD, [0, 1.44, 0])[1] - 0.06);
    if (d.bustY !== undefined) lo[1] = Math.max(lo[1], d.bustY - 0.05);
    lo = sub(lo, [h * 2, h * 2, h * 2]); hi = add(hi, [h * 2, h * 2, h * 2]);
    if (lo[1] >= hi[1]) continue;
    polygonise(F, lo, hi, h, out, paint);
  }
  // A bust stands on its pillar: its cut at the foot of the mesh.
  if (d.bustY !== undefined) for (let i = 1; i < out.position.length; i += 3) out.position[i] -= d.bustY;
  let top = 0;
  for (let i = 1; i < out.position.length; i += 3) top = Math.max(top, out.position[i]);
  const grips = figure ? [gripAt(bones, 1), gripAt(bones, -1)] : [];
  const built = { ...out, style: marble ? STYLE_STATUE_MARBLE : STYLE_BRONZE, height: top, grips, bit };
  cache.set(key, built);
  return built;
}

/**
 * Write a mesh into the town's store at `at`, turned by `yaw` (front to
 * (sin yaw, cos yaw)), scaled. The vertex seed carries how thin the
 * material is there, for the marble's light through its edges.
 */
export function emitStatue(st: Sink, m: StatueMesh & { style: number }, at: V3, yaw: number, scale: number): number {
  const ca = Math.cos(yaw), sa = Math.sin(yaw), base = st.n;
  for (let i = 0; i < m.position.length / 3; i++) {
    const x = m.position[i * 3] * scale, y = m.position[i * 3 + 1] * scale, z = m.position[i * 3 + 2] * scale;
    const nx = m.normal[i * 3], ny = m.normal[i * 3 + 1], nz = m.normal[i * 3 + 2];
    st.vert([at[0] + x * ca + z * sa, at[1] + y, at[2] - x * sa + z * ca], [nx * ca + nz * sa, ny, -nx * sa + nz * ca],
      [m.colour[i * 3], m.colour[i * 3 + 1], m.colour[i * 3 + 2]], m.thin[i] ?? 0.5, m.style, 0, 0, [0, 0, 0, 0]);
  }
  for (let k = 0; k < m.index.length; k += 3) st.tri(base + m.index[k], base + m.index[k + 1], base + m.index[k + 2]);
  return m.index.length / 3;
}

/** A point of a statue's own frame placed as emitStatue places it. */
const placeP = (p: V3, at: V3, yaw: number, s: number): V3 => {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  return [at[0] + (p[0] * ca + p[2] * sa) * s, at[1] + p[1] * s, at[2] + (-p[0] * sa + p[2] * ca) * s];
};

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

/**
 * A statue to be built and placed. The town's build only lays the bases
 * and lists these: sculpting them takes a second or two, so render/pompeii.ts
 * builds them into a mesh of their own after the town is up (runStatueJob).
 */
export interface StatueJob { kind: StatueKind; lean: boolean; marble?: boolean; at: V3; yaw: number; scale: number; fit?: number; horse?: boolean }
let JOBS: StatueJob[] = [];
/** The statues listed since the last call, for the caller to build. */
export function takeStatueJobs(): StatueJob[] { const j = JOBS; JOBS = []; return j; }

/** Build one listed statue (with its horse and reins for a rider) into a store; its triangles. */
export function runStatueJob(st: Sink, j: StatueJob): number {
  if (!j.horse) {
    const m = buildStatue(j.kind, j.lean, { marble: j.marble });
    return emitStatue(st, m, j.at, j.yaw, j.fit ? j.fit / m.height : j.scale);
  }
  const s = j.scale;
  const horse = buildStatue("horse", false);
  let tris = emitStatue(st, horse, j.at, j.yaw, s);
  // The rider astride on the saddle cloth just behind the withers, at the
  // horse's own scale: his seat (the crotch, 0.82 m up his frame) on its back.
  const rider = buildStatue("rider", false);
  const seatOff: V3 = [0, 0.64, 0.06];
  tris += emitStatue(st, rider, placeP(seatOff, j.at, j.yaw, s), j.yaw, s);
  // The reins from the bit to his left hand, sagging a little.
  if (horse.bit) {
    const hand = add(rider.grips[0], seatOff), reins: StatueMesh = { position: [], normal: [], colour: [], index: [], thin: [] };
    for (const b of horse.bit) {
      const mid: V3 = add(lerp3(b, hand, 0.5), [0, -0.06, 0]);
      tube(reins, [b, mid, 0.007, 0.007], DARK);
      tube(reins, [mid, hand, 0.007, 0.007], DARK);
    }
    tris += emitStatue(st, { ...reins, style: STYLE_BRONZE }, j.at, j.yaw, s);
  }
  return tris;
}

/** Every statue placed, in the town's pack metres, for the shots that frame them (`?statuecam=`). */
export const STATUE_SPOTS: { kind: StatueKind; x: number; y: number; z: number; yaw: number; top: number }[] = [];

/** Honorands of the forum's bases (the dedications found there, shortened to fit a die). */
const DEDICATIONS = [
  ["M.LVCRETIO.DECIDIANO", "RVFO.II.VIR.III"], ["C.CVSPIO.C.F.PANSAE", "AED.II.VIR"], ["Q.SALLVSTIO.P.F", "II.VIR.I.D"],
  ["A.VMBRICIO.SCAVRO", "II.VIR.I.D"], ["M.HOLCONIO.CELERI", "SACERDOTI.AVGVSTI"], ["CN.ALLEIO.NIGIDIO", "MAIO.II.VIR"],
];

/** A statue on its base, its figure scaled so it stands `figureM` tall. */
function standing(st: Sink, kind: StatueKind, lean: boolean, x: number, y: number, z: number, yaw: number, figureM: number, base: { hx: number; hz: number; h: number; lines: string[] }, seed: number, marble?: boolean): number {
  const tris = statueBase(st, x, y, z, yaw, base.hx, base.hz, base.h, base.lines, seed);
  JOBS.push({ kind, lean, marble, at: [x, y + base.h, z], yaw, scale: figureM / 1.7 });
  STATUE_SPOTS.push({ kind, x, y: y + base.h, z, yaw, top: y + base.h + figureM });
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
  JOBS.push({ kind: "rider", lean: false, at: [x, g + h, z], yaw: hyaw, scale: s, horse: true });
  STATUE_SPOTS.push({ kind: "rider", x, y: g + h, z, yaw: hyaw, top: g + h + 2.5 * s });
  return tris;
}

/** The Dancing Faun on a small moulded base by the impluvium, 0.71 m to his raised hand. */
export function faunStatue(st: Sink, x: number, floor: number, z: number, yaw: number, lean: boolean, seed: number): number {
  const tris = statueBase(st, x, floor - 0.1, z, yaw, 0.2, 0.2, 0.6, [], seed);
  JOBS.push({ kind: "faun", lean, at: [x, floor + 0.5, z], yaw, scale: 0, fit: 0.71 });
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

const hashU = (i: number, x: number): number => { const v = Math.sin(i * 127.1 + x * 311.7) * 43758.5453; return v - Math.floor(v); };

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
  ground: (x: number, z: number) => number, kerb: number, lean: boolean, seed: number, gardens: { x: number; y: number; z: number; yaw: number }[] = []): { tris: number; placed: string[] } {
  let tris = 0;
  const placed: string[] = [];
  const floorOf = (r: number[]): number => { let g = 1e9; for (let i = 0; i < r.length; i += 2) g = Math.min(g, ground(r[i], r[i + 1])); return g + kerb; };
  const apollo = data.publics.find((p) => /Tempio di Apollo/.test(p.name));
  if (apollo) {
    const o = axes(apollo.ring), g = floorOf(apollo.ring);
    // Out in the court in front of the portico on the two long sides, a
    // third of the way from the front, in the sun, facing each other across.
    for (const [kind, side] of [["apollo", 1], ["diana", -1]] as [StatueKind, number][]) {
      const u = o.hu * 0.35, v = side * (o.hv - 7.5);
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
    // On the tip of the pavement at the crossroads' north-west corner, out
    // by the kerbs and clear of the house corner behind, facing the junction.
    const dir = (p: number[]): [number, number] => { const dx = p[p.length - 2] - p[0], dz = p[p.length - 1] - p[1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; };
    const [sx, sz] = dir(stabia.pts), [ax, az] = dir(abb.pts);
    let nx = -sz, nz = sx; if (nz > 0) { nx = -nx; nz = -nz; }
    let wx = -az, wz = ax; if (wx > 0) { wx = -wx; wz = -wz; }
    const dn = abb.carriageM / 2 + 0.5, dw = stabia.carriageM / 2 + 0.5;
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
  // Garden bronzes on the peristyles' pedestals (full detail only: they are small and many).
  if (!lean) gardens.slice(0, 12).forEach((b, i) => {
    const kind: StatueKind = (["boy", "satyr", "herm"] as const)[Math.floor(hashU(i, b.x) * 3)];
    const tall = kind === "herm" ? 0.75 : kind === "boy" ? 0.7 : 0.8;
    JOBS.push({ kind, lean: false, at: [b.x, b.y, b.z], yaw: b.yaw, scale: 0, fit: tall });
    STATUE_SPOTS.push({ kind, x: b.x, y: b.y, z: b.z, yaw: b.yaw, top: b.y + tall });
    placed.push(kind);
  });
  return { tris, placed };
}
