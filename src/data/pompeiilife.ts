// Pompeii's street life: a few dozen people walking the pavements and the
// forum, and a couple of carts on the main streets. The simulation only;
// render/pompeii.ts draws it. Pure, so test/pompeii.check.ts runs it.
//
// Everyone walks a fixed path (a pavement down one side of a street, a loop
// round the forum) back and forth. Only the ones near the camera matter, so
// whoever wanders past LIFE_RADIUS_M is put back on a path near it: a few
// dozen people then fill the streets you can see rather than a town of 66
// hectares.

import { pointInRing, type PompeiiData } from "./pompeii";

export const LIFE_RADIUS_M = 260;

export interface LifeAgent {
  x: number;
  z: number;
  /** Heading, radians clockwise from north (-z), as the car sim's. */
  heading: number;
  /** Walk-cycle phase, radians. */
  phase: number;
  speed: number;
  /** Tunic colour index. */
  tint: number;
  path: number;
  s: number;
  dir: number;
}

interface Path {
  pts: number[];
  /** Cumulative length at each vertex. */
  cum: number[];
  len: number;
  kind: "pavement" | "forum" | "street";
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function makePath(pts: number[], kind: Path["kind"]): Path {
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  return { pts, cum, len: cum[cum.length - 1], kind };
}

/** A polyline offset sideways by `d` (positive to the right of travel, x east, z south). */
function offsetLine(p: number[], d: number): number[] {
  const n = p.length / 2, out: number[] = [];
  for (let i = 0; i < n; i++) {
    let tx = 0, tz = 0;
    if (i > 0) { const dx = p[i * 2] - p[i * 2 - 2], dz = p[i * 2 + 1] - p[i * 2 - 1], L = Math.hypot(dx, dz) || 1; tx += dx / L; tz += dz / L; }
    if (i < n - 1) { const dx = p[i * 2 + 2] - p[i * 2], dz = p[i * 2 + 3] - p[i * 2 + 1], L = Math.hypot(dx, dz) || 1; tx += dx / L; tz += dz / L; }
    const L = Math.hypot(tx, tz) || 1;
    out.push(p[i * 2] - (tz / L) * d, p[i * 2 + 1] + (tx / L) * d);
  }
  return out;
}

/** Share of a path, sampled every 4 m, that lies on some insula's kerb block. */
function onPavement(data: PompeiiData, p: Path): number {
  let n = 0, k = 0;
  for (let s = 2; s < p.len; s += 4) {
    let i = 1;
    while (i < p.cum.length - 1 && p.cum[i] < s) i++;
    const t = (s - p.cum[i - 1]) / (p.cum[i] - p.cum[i - 1] || 1);
    const x = p.pts[i * 2 - 2] + (p.pts[i * 2] - p.pts[i * 2 - 2]) * t, z = p.pts[i * 2 - 1] + (p.pts[i * 2 + 1] - p.pts[i * 2 - 1]) * t;
    n++;
    if (data.insulae.some((ins) => pointInRing(ins.kerb, x, z))) k++;
  }
  return n ? k / n : 0;
}

export class PompeiiLife {
  readonly people: LifeAgent[] = [];
  readonly carts: LifeAgent[] = [];
  private readonly paths: Path[] = [];
  private readonly cartPaths: Path[] = [];
  private readonly rand: () => number;
  private started = false;
  private readonly kerbs: number[][];

  constructor(data: PompeiiData, opts: { people: number; carts: number; seed?: number }) {
    this.rand = rng(opts.seed ?? 79);
    this.kerbs = data.insulae.map((i) => i.kerb);
    for (const s of data.streets) {
      if (s.pts.length < 4) continue;
      // Down the middle of each pavement, both sides.
      const off = s.carriageM / 2 + s.sidewalkM / 2;
      for (const side of [-1, 1]) {
        const p = makePath(offsetLine(s.pts, side * off), "pavement");
        // Only where the line really runs on a pavement: the offset of a
        // street past a junction or out through a gate falls on the road.
        if (p.len > 20 && onPavement(data, p) > 0.9) this.paths.push(p);
      }
      if (s.main && !s.inferred) {
        const p = makePath(s.pts, "street");
        if (p.len > 60) this.cartPaths.push(p);
      }
    }
    // The forum: loops between points on the open square, many of them, as
    // it was the busiest ground in the town.
    const forum = data.publics.find((p) => p.kind === "forum");
    if (forum) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < forum.ring.length; i += 2) {
        x0 = Math.min(x0, forum.ring[i]); x1 = Math.max(x1, forum.ring[i]); z0 = Math.min(z0, forum.ring[i + 1]); z1 = Math.max(z1, forum.ring[i + 1]);
      }
      for (let k = 0; k < 12; k++) {
        const pts: number[] = [];
        for (let guard = 0; guard < 200 && pts.length < 10; guard++) {
          const x = x0 + this.rand() * (x1 - x0), z = z0 + this.rand() * (z1 - z0);
          // Clear of the porticoes round the edge.
          if (pointInRing(forum.ring, x, z) && pointInRing(forum.ring, x + 8, z) && pointInRing(forum.ring, x - 8, z) && pointInRing(forum.ring, x, z + 8) && pointInRing(forum.ring, x, z - 8)) pts.push(x, z);
        }
        if (pts.length >= 4) this.paths.push(makePath(pts, "forum"));
      }
    }
    for (let i = 0; i < opts.people; i++) {
      this.people.push({ x: 0, z: 0, heading: 0, phase: this.rand() * Math.PI * 2, speed: 1.1 + this.rand() * 0.5, tint: Math.floor(this.rand() * 8), path: -1, s: 0, dir: 1 });
    }
    for (let i = 0; i < Math.min(opts.carts, this.cartPaths.length); i++) {
      this.carts.push({ x: 0, z: 0, heading: 0, phase: 0, speed: 1.4 + this.rand() * 0.3, tint: 0, path: -1, s: 0, dir: 1 });
    }
  }

  /** Paths that pass within `r` of a point. */
  private near(list: Path[], x: number, z: number, r: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < list.length; k++) {
      const p = list[k].pts;
      for (let i = 0; i < p.length; i += 2) if (Math.abs(p[i] - x) < r && Math.abs(p[i + 1] - z) < r && Math.hypot(p[i] - x, p[i + 1] - z) < r) { out.push(k); break; }
    }
    return out;
  }

  private place(a: LifeAgent, list: Path[], cands: number[], cx: number, cz: number, r: number): void {
    if (!cands.length) { a.path = -1; return; }
    // A few tries for a spot on the pavement itself: a path's ends and its
    // junction crossings are on the road.
    for (let tries = 0; tries < 8; tries++) {
      a.path = cands[Math.floor(this.rand() * cands.length)];
      const p = list[a.path];
      // Somewhere along it near the camera, so the next frame does not find
      // them out of range and move them again.
      const close: number[] = [];
      for (let i = 0; i < p.cum.length; i++) if (Math.hypot(p.pts[i * 2] - cx, p.pts[i * 2 + 1] - cz) < r) close.push(i);
      const at = close.length ? p.cum[close[Math.floor(this.rand() * close.length)]] : this.rand() * p.len;
      a.s = Math.max(0, Math.min(p.len, at + (this.rand() - 0.5) * 16));
      a.dir = this.rand() < 0.5 ? 1 : -1;
      this.pose(a, p);
      if (p.kind !== "pavement" || this.kerbs.some((k) => pointInRing(k, a.x, a.z))) return;
    }
  }

  private pose(a: LifeAgent, p: Path): void {
    let i = 1;
    while (i < p.cum.length - 1 && p.cum[i] < a.s) i++;
    const L = p.cum[i] - p.cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (a.s - p.cum[i - 1]) / L));
    const ax = p.pts[i * 2 - 2], az = p.pts[i * 2 - 1], bx = p.pts[i * 2], bz = p.pts[i * 2 + 1];
    a.x = ax + (bx - ax) * t;
    a.z = az + (bz - az) * t;
    const dx = (bx - ax) * a.dir, dz = (bz - az) * a.dir;
    a.heading = Math.atan2(dx, -dz);
  }

  /** Advance by dt seconds; (cx, cz) is the camera in pack metres. */
  update(dt: number, cx: number, cz: number): void {
    const first = !this.started;
    this.started = true;
    const nearPeople = first || this.people.some((a) => a.path < 0 || Math.hypot(a.x - cx, a.z - cz) > LIFE_RADIUS_M) ? this.near(this.paths, cx, cz, LIFE_RADIUS_M * 0.8) : [];
    for (const a of this.people) {
      if (a.path < 0 || Math.hypot(a.x - cx, a.z - cz) > LIFE_RADIUS_M) { this.place(a, this.paths, nearPeople, cx, cz, LIFE_RADIUS_M * 0.8); continue; }
      this.step(a, this.paths[a.path], dt);
    }
    const nearCarts = first || this.carts.some((a) => a.path < 0 || Math.hypot(a.x - cx, a.z - cz) > LIFE_RADIUS_M * 1.5) ? this.near(this.cartPaths, cx, cz, LIFE_RADIUS_M) : [];
    for (const a of this.carts) {
      if (a.path < 0 || Math.hypot(a.x - cx, a.z - cz) > LIFE_RADIUS_M * 1.5) { this.place(a, this.cartPaths, nearCarts, cx, cz, LIFE_RADIUS_M); continue; }
      this.step(a, this.cartPaths[a.path], dt);
    }
  }

  private step(a: LifeAgent, p: Path, dt: number): void {
    a.s += a.speed * a.dir * dt;
    // Turn round at the end of the path: a shop, a doorway, a corner.
    if (a.s > p.len) { a.s = p.len; a.dir = -1; }
    if (a.s < 0) { a.s = 0; a.dir = 1; }
    a.phase += (a.speed / 1.4) * Math.PI * 2 * dt;
    this.pose(a, p);
  }

  /** Pavement paths, for the gate. */
  get pathCount(): { pavement: number; forum: number; street: number } {
    return {
      pavement: this.paths.filter((p) => p.kind === "pavement").length,
      forum: this.paths.filter((p) => p.kind === "forum").length,
      street: this.cartPaths.length,
    };
  }
}
