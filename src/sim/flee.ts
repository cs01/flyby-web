// The townsfolk leaving: once the pumice starts to fall, the people in the
// streets make for the nearest gate with what they can carry, the carts with
// them, and the crowd thickens where the streets meet the gates. Most left in
// the first hours (data/escape.ts), so the streets empty as the night goes on.
//
// A flow field, not a street graph: the streets are stamped into a 4 m grid
// and a breadth-first search from every gate gives each cell its walking
// distance out. An agent steps to whichever neighbour is closer to a gate.
// The town's polylines do not share vertices at junctions, so a graph built
// from them would be broken wherever two streets meet; the grid is not.
//
// Pure (no THREE, no DOM): test/eruption.check.ts walks it.

import type { LifeAgent } from "../data/pompeiilife";
import type { PompeiiData } from "../data/pompeii";

export const FLEE_CELL_M = 4;
const UNREACHED = 0xffff;

/** Share of the street crowd still in the town at hour h (sim/eruption.ts clock). */
export function crowdShare(h: number): number {
  if (h < 13.5) return 1;
  if (h < 16) return 1;
  if (h < 20) return 1 - 0.8 * ((h - 16) / 4);
  if (h < 26) return 0.2 - 0.12 * ((h - 20) / 6);
  return 0.08;
}

export class FleeField {
  readonly x0: number;
  readonly z0: number;
  readonly w: number;
  readonly h: number;
  /** Cells to the nearest gate, UNREACHED off the streets. */
  readonly dist: Uint16Array;
  /** Walkable cells, for placing people. */
  readonly open: number[] = [];
  /** Gate positions with their outward direction (from the town's middle). */
  readonly gates: { name: string; x: number; z: number; ox: number; oz: number }[] = [];

  constructor(data: PompeiiData) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < data.wall.length; i += 2) {
      x0 = Math.min(x0, data.wall[i]); x1 = Math.max(x1, data.wall[i]);
      z0 = Math.min(z0, data.wall[i + 1]); z1 = Math.max(z1, data.wall[i + 1]);
    }
    const pad = 40;
    this.x0 = x0 - pad;
    this.z0 = z0 - pad;
    this.w = Math.ceil((x1 - x0 + 2 * pad) / FLEE_CELL_M);
    this.h = Math.ceil((z1 - z0 + 2 * pad) / FLEE_CELL_M);
    const walk = new Uint8Array(this.w * this.h);
    const stamp = (x: number, z: number, r: number) => {
      const i0 = Math.max(0, Math.floor((x - r - this.x0) / FLEE_CELL_M)), i1 = Math.min(this.w - 1, Math.floor((x + r - this.x0) / FLEE_CELL_M));
      const j0 = Math.max(0, Math.floor((z - r - this.z0) / FLEE_CELL_M)), j1 = Math.min(this.h - 1, Math.floor((z + r - this.z0) / FLEE_CELL_M));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cx = this.x0 + (i + 0.5) * FLEE_CELL_M, cz = this.z0 + (j + 0.5) * FLEE_CELL_M;
        if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) walk[j * this.w + i] = 1;
      }
    };
    for (const s of data.streets) {
      const r = Math.max(2.5, s.carriageM / 2 + s.sidewalkM * 0.5);
      for (let k = 2; k < s.pts.length; k += 2) {
        const ax = s.pts[k - 2], az = s.pts[k - 1], bx = s.pts[k], bz = s.pts[k + 1];
        const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 2));
        for (let q = 0; q <= n; q++) stamp(ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n, r);
      }
    }
    // The forum and the open squares are walkable too.
    for (const p of data.publics) if (p.kind === "forum") {
      for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
        const cx = this.x0 + (i + 0.5) * FLEE_CELL_M, cz = this.z0 + (j + 0.5) * FLEE_CELL_M;
        if (inRing(p.ring, cx, cz)) walk[j * this.w + i] = 1;
      }
    }
    let mx = 0, mz = 0;
    for (let i = 0; i < data.wall.length; i += 2) { mx += data.wall[i]; mz += data.wall[i + 1]; }
    mx /= data.wall.length / 2; mz /= data.wall.length / 2;
    this.dist = new Uint16Array(this.w * this.h).fill(UNREACHED);
    const queue: number[] = [];
    for (const g of data.gates) {
      stamp(g.x, g.z, 8);
      const L = Math.hypot(g.x - mx, g.z - mz) || 1;
      this.gates.push({ name: g.name, x: g.x, z: g.z, ox: (g.x - mx) / L, oz: (g.z - mz) / L });
      const c = this.cell(g.x, g.z);
      if (c >= 0) { this.dist[c] = 0; queue.push(c); }
    }
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q], ci = c % this.w, cj = (c - ci) / this.w, d = this.dist[c] + 1;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
        const n = j * this.w + i;
        if (!walk[n] || this.dist[n] !== UNREACHED) continue;
        this.dist[n] = d;
        queue.push(n);
      }
    }
    for (let c = 0; c < this.dist.length; c++) if (this.dist[c] !== UNREACHED && this.dist[c] > 2) this.open.push(c);
  }

  cell(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / FLEE_CELL_M), j = Math.floor((z - this.z0) / FLEE_CELL_M);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }

  /** Cells to the nearest gate from (x, z); Infinity off the streets. */
  distanceAt(x: number, z: number): number {
    const c = this.cell(x, z);
    return c < 0 || this.dist[c] === UNREACHED ? Infinity : this.dist[c];
  }

  /** Centre of the neighbouring cell one step nearer a gate, or null at a gate or off the streets. */
  downhill(x: number, z: number): [number, number] | null {
    const c = this.cell(x, z);
    if (c < 0 || this.dist[c] === UNREACHED || this.dist[c] === 0) return null;
    const ci = c % this.w, cj = (c - ci) / this.w;
    let best = this.dist[c], bi = -1, bj = -1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
      const d = this.dist[j * this.w + i];
      if (d < best) { best = d; bi = i; bj = j; }
    }
    return bi < 0 ? null : [this.x0 + (bi + 0.5) * FLEE_CELL_M, this.z0 + (bj + 0.5) * FLEE_CELL_M];
  }

  centre(c: number): [number, number] {
    const i = c % this.w, j = (c - i) / this.w;
    return [this.x0 + (i + 0.5) * FLEE_CELL_M, this.z0 + (j + 0.5) * FLEE_CELL_M];
  }
}

function inRing(r: number[], x: number, z: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Per-agent state the life sim does not have: where in the stream, what is carried. */
interface Flight { side: number; out: number; gate: number; bundle: boolean; active: boolean }

const PLACE_MIN_M = 25;
const PLACE_MAX_M = 220;
/** Past the gate, people walk on this far before they are recycled. */
const OUT_M = 40;

/**
 * Drives the life sim's agents (data/pompeiilife.ts) once the fall starts:
 * they are the same people, now heading out.
 */
export class Flee {
  private readonly flights = new Map<LifeAgent, Flight>();
  private seed = 1979;

  constructor(readonly field: FleeField) {}

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** Put an agent somewhere on the streets near (cx, cz), and on its way. */
  private place(a: LifeAgent, f: Flight, cx: number, cz: number): void {
    const open = this.field.open;
    for (let tries = 0; tries < 24; tries++) {
      const [x, z] = this.field.centre(open[Math.floor(this.rand() * open.length)]);
      const d = Math.hypot(x - cx, z - cz);
      if (d < PLACE_MIN_M || d > PLACE_MAX_M) continue;
      a.x = x + (this.rand() - 0.5) * 2;
      a.z = z + (this.rand() - 0.5) * 2;
      f.out = -1;
      return;
    }
    a.x = 1e5; a.z = 1e5;
  }

  /**
   * One step for everyone. `share` is crowdShare(h): the rest are parked out of
   * sight. `pace` slows them in deep pumice. Returns how many are walking.
   */
  update(people: LifeAgent[], carts: LifeAgent[], dt: number, cx: number, cz: number, share: number, pace: number): number {
    let walking = 0;
    const all = [...people, ...carts];
    all.forEach((a, k) => {
      let f = this.flights.get(a);
      const isCart = k >= people.length;
      if (!f) {
        f = { side: (this.rand() - 0.5) * 2.4, out: -1, gate: -1, bundle: this.rand() < 0.7, active: true };
        this.flights.set(a, f);
        if (this.field.distanceAt(a.x, a.z) === Infinity || Math.hypot(a.x - cx, a.z - cz) > PLACE_MAX_M) this.place(a, f, cx, cz);
      }
      // Fewer people later: an agent whose turn it is not stays parked.
      f.active = isCart ? share > 0.3 : (k + 0.5) / people.length < share;
      if (!f.active) { a.x = 1e5; a.z = 1e5; return; }
      if (a.x > 5e4 || Math.hypot(a.x - cx, a.z - cz) > PLACE_MAX_M * 1.3) this.place(a, f, cx, cz);
      if (a.x > 5e4) return;
      const speed = a.speed * (isCart ? 1.2 : 1.25) * pace;
      let tx: number, tz: number;
      if (f.out >= 0) {
        // Through the gate and away down the road.
        const g = this.field.gates[f.gate];
        tx = a.x + g.ox; tz = a.z + g.oz;
        f.out += speed * dt;
        if (f.out > OUT_M) { this.place(a, f, cx, cz); return; }
      } else {
        const next = this.field.downhill(a.x, a.z);
        if (!next) {
          // At a gate: through it.
          let gi = 0, gd = Infinity;
          this.field.gates.forEach((g, i) => { const d = Math.hypot(g.x - a.x, g.z - a.z); if (d < gd) { gd = d; gi = i; } });
          if (gd > 20) { this.place(a, f, cx, cz); return; }
          f.gate = gi; f.out = 0;
          return;
        }
        [tx, tz] = next;
        // Each keeps to their own line in the street, so a crowd is a crowd
        // and not a single file.
        const dx = tx - a.x, dz = tz - a.z, L = Math.hypot(dx, dz) || 1;
        tx += (-dz / L) * f.side * (isCart ? 0 : 1);
        tz += (dx / L) * f.side * (isCart ? 0 : 1);
      }
      const dx = tx - a.x, dz = tz - a.z, L = Math.hypot(dx, dz);
      if (L > 1e-3) {
        const step = Math.min(L, speed * dt);
        a.x += (dx / L) * step;
        a.z += (dz / L) * step;
        a.heading = Math.atan2(dx, -dz);
      }
      a.phase += (speed / 1.4) * Math.PI * 2 * dt;
      walking++;
    });
    return walking;
  }

  /** Who is carrying a bundle, and where: for the renderer. */
  bundles(people: LifeAgent[]): LifeAgent[] {
    return people.filter((a) => { const f = this.flights.get(a); return !!f && f.active && f.bundle && a.x < 5e4; });
  }
}
