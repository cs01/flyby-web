// The transit layer, end to end: loads the city's baked pack, polls its live
// feeds, keeps every train and boat moving (data/transit.ts), draws them
// (render/transit.ts) and tags them (app/transittags.ts). main.ts holds one
// and calls update() once a frame.
//
// POLLING. Every 30 s while the tab is visible and the layer the feed serves
// is on: the MTA rebuilds its feeds about every 30 s (headers 30 s apart on
// 2026-10-24), so faster buys nothing and costs a phone 300 kB a cycle. A
// hidden tab stops; the next visible frame polls at once. An agency whose
// feeds have failed for FALLBACK_S runs on its baked timetable instead, so a
// proxy that is down shows "scheduled" trains rather than an empty city.
//
// SCREENSHOTS. `?shot` leaves the layer off, like the air traffic, so a pose
// renders the same pixels every run. `?transit=<name>` (dev only) replays
// test/fixtures/transit-<name>/ and freezes the clock at its capture time,
// which makes the trains in a shot as fixed as the buildings. `?notransit=1`
// turns it off outright.

import * as THREE from "three";
import type { Origin } from "../geo";
import { decodeFeed } from "../data/gtfsrt";
import { FEEDS, type FeedSpec } from "../data/transitfeeds";
import { parseTransitPack, Level, type RawPack, type TransitPack } from "../data/transitpack";
import { TransitModel, trackHeights } from "../data/transit";
import { axisOf, profileY, type Landmark } from "../data/landmarks";
import type { AircraftModel } from "../render/aircraftmodel";
import { TransitRender, structureColor } from "../render/transit";
import { TransitTags, type TagCandidate } from "./transittags";

const POLL_MS = 30000;
const FALLBACK_S = 150;

/**
 * Where trains run on a landmark bridge, relative to its surveyed roadway.
 * The Manhattan Bridge's four subway tracks are on the lower level, with the
 * lower roadway (data/landmarks.ts layerDy, -7.5 m); the Williamsburg's J/M/Z
 * run between its roadways, on their level.
 */
const RAIL_DY: Record<string, number> = { manhattanbr: -7.5, williamsburg: 0 };

export interface TransitLayerOptions {
  scene: THREE.Scene;
  ui: HTMLElement;
  model: AircraftModel;
  origin: Origin;
  cityId: string;
  groundAt: (x: number, z: number) => number;
  waterY: number;
  landmarks: readonly Landmark[];
  shotMode: boolean;
}

/** A dot for the radar and the minimap. */
export interface TransitBlip {
  x: number;
  z: number;
  color: string;
  under: boolean;
  boat: boolean;
}

export class TransitLayer {
  readonly available: boolean;
  pack: TransitPack | null = null;
  model: TransitModel | null = null;
  render: TransitRender | null = null;
  tags: TransitTags | null = null;
  private feeds: FeedSpec[];
  private heights = new Map<number, Float32Array[]>();
  private lastPoll = -Infinity;
  private polling = false;
  private lastOk = new Map<string, number>();
  private frozenAt: number | null = null;
  private fixtureReady = true;
  /** Last frame's blips, for the radar and the minimap. */
  readonly blips: TransitBlip[] = [];
  polls = 0;
  lastError = "";

  constructor(private o: TransitLayerOptions) {
    const params = new URLSearchParams(location.search);
    const fixture = import.meta.env.DEV ? params.get("transit") : null;
    this.available = !params.has("notransit") && (!o.shotMode || fixture !== null);
    this.feeds = FEEDS[o.cityId] ?? [];
    if (!this.available) return;
    if (fixture) this.fixtureReady = false;
    void fetch(`${import.meta.env.BASE_URL}transit/${o.cityId}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (raw: RawPack | null) => {
        if (!raw) return; // a city with no transit pack
        this.setup(parseTransitPack(raw));
        if (fixture) await this.replay(fixture);
      })
      .catch((e: unknown) => {
        this.lastError = String(e);
        console.error("[flyby] transit pack failed", e);
      });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.lastPoll = -Infinity;
    });
  }

  private setup(pack: TransitPack): void {
    const t0 = performance.now();
    this.pack = pack;
    this.model = new TransitModel(pack, this.o.origin);
    this.render = new TransitRender(this.o.model, pack);
    this.tags = new TransitTags(this.o.ui, pack);
    this.render.group.name = "transit";
    this.o.scene.add(this.render.group);
    // The elevated structure stands where the trains run: every elevated
    // track point, hashed on a 10 m grid, gives its rail height.
    const grid = new Map<string, number[]>();
    pack.shapes.forEach((sh, si) => {
      const pat = pack.patterns.find((p) => p.shape === si);
      if (!pat || pack.agencies[pack.routes[pat.route].agency].kind === "ferry") return;
      const hs = this.shapeHeights(si);
      sh.runs.forEach((run, ri) => {
        for (let i = 0; i + 1 < run.s.length; i++) {
          if (run.lvl[i] !== Level.Elevated && run.lvl[i + 1] !== Level.Elevated) continue;
          const L = run.s[i + 1] - run.s[i];
          for (let d = 0; d <= L; d += 5) {
            const u = L > 0 ? d / L : 0;
            const x = run.pts[i * 2] + (run.pts[i * 2 + 2] - run.pts[i * 2]) * u;
            const z = run.pts[i * 2 + 1] + (run.pts[i * 2 + 3] - run.pts[i * 2 + 1]) * u;
            const y = hs[ri][i] + (hs[ri][i + 1] - hs[ri][i]) * u;
            const k = `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
            let a = grid.get(k);
            if (!a) grid.set(k, (a = []));
            a.push(x, z, y);
          }
        }
      });
    });
    const railAt = (x: number, z: number): number | null => {
      let best = 8;
      let y: number | null = null;
      const cx = Math.floor(x / 10), cz = Math.floor(z / 10);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const a = grid.get(`${cx + i},${cz + j}`);
          if (!a) continue;
          for (let k = 0; k < a.length; k += 3) {
            const d = Math.hypot(a[k] - x, a[k + 1] - z);
            if (d < best) {
              best = d;
              y = a[k + 2];
            }
          }
        }
      }
      return y;
    };
    this.render.buildStructure(railAt, this.o.groundAt, structureColor(pack));
    console.log(
      `[flyby] transit: ${pack.routes.length} routes, ${pack.patterns.length} patterns, ` +
        `${this.render.stats.structureTris} structure triangles, ${(performance.now() - t0).toFixed(0)} ms`,
    );
  }

  private shapeHeights(si: number): Float32Array[] {
    let h = this.heights.get(si);
    if (h) return h;
    const pack = this.pack!;
    const pat = pack.patterns.find((p) => p.shape === si)!;
    const agency = pack.agencies[pack.routes[pat.route].agency];
    const pinned = this.o.landmarks.filter((l) => l.spec.zone && l.spec.profile);
    const deckAt = (x: number, z: number): number | null => {
      for (const l of pinned) {
        const { t, s } = axisOf(l, x, z);
        const zn = l.spec.zone!;
        if (t >= zn[0] && t <= zn[1] && Math.abs(s) <= l.spec.halfWidthM + 6) return profileY(l.spec, t) + (RAIL_DY[l.spec.id] ?? 0);
      }
      return null;
    };
    h = trackHeights(pack.shapes[si], this.o.groundAt, agency.elevatedM, deckAt);
    this.heights.set(si, h);
    return h;
  }

  private async replay(name: string): Promise<void> {
    this.frozenAt = 0;
    try {
      const base = `/test/fixtures/transit-${encodeURIComponent(name)}/`;
      const meta = (await (await fetch(`${base}meta.json`)).json()) as { now: number; feeds: string[] };
      this.frozenAt = meta.now;
      for (const k of meta.feeds) {
        const f = this.feeds.find((x) => x.key === k);
        if (!f) continue;
        const buf = new Uint8Array(await (await fetch(`${base}${k}.pb`)).arrayBuffer());
        this.model!.ingest(f.agency, decodeFeed(buf), meta.now);
      }
    } catch (e) {
      this.lastError = String(e);
      console.error("[flyby] transit fixture failed", e);
    }
    this.fixtureReady = true;
  }

  private poll(trains: boolean, boats: boolean): void {
    if (this.polling || this.frozenAt !== null || !this.model) return;
    const want = this.feeds.filter((f) => (f.agency === "nycferry" ? boats : trains));
    if (!want.length) return;
    this.polling = true;
    // In order, not all at once: the ferry's arrivals feed must land before
    // its positions (data/transit.ts ingestBoat), and seven parallel MTA
    // requests on a phone's first frame were the slowest thing on the page.
    void (async () => {
      for (const f of want) {
        try {
          const r = await fetch(f.path);
          if (!r.ok) throw new Error(`${f.key} ${r.status}`);
          const msg = decodeFeed(new Uint8Array(await r.arrayBuffer()));
          this.model!.ingest(f.agency, msg, Date.now());
          this.lastOk.set(f.agency, Date.now());
          this.polls++;
        } catch (e) {
          this.lastError = String(e);
        }
      }
      this.polling = false;
    })();
  }

  update(
    camera: THREE.PerspectiveCamera,
    bufferH: number,
    dt: number,
    night: number,
    trains: boolean,
    boats: boolean,
    avoid: { x: number; y: number; w: number; h: number }[],
  ): void {
    this.blips.length = 0;
    const r = this.render;
    const show = this.available && (trains || boats) && !!r && !!this.model;
    if (r) r.group.visible = show;
    if (this.tags) this.tags.visible = show;
    if (!show || !r || !this.model || !this.pack || !this.tags) {
      this.tags?.update(camera, [], this.model!, 0, []);
      return;
    }
    if (!this.fixtureReady) return;
    const now = this.frozenAt ?? Date.now();
    const model = this.model;
    if (this.frozenAt === null) {
      if (document.visibilityState === "visible" && now - this.lastPoll >= POLL_MS) {
        this.lastPoll = now;
        this.poll(trains, boats);
      }
      // Feeds gone quiet: hand the agency back to its timetable.
      for (const a of [...model.liveAgencies]) {
        const live = this.pack.agencies[a].live;
        if (now - (this.lastOk.get(live) ?? 0) > FALLBACK_S * 1000) model.liveAgencies.delete(a);
      }
    }
    model.step(now);
    r.trains = trains;
    r.boats = boats;
    r.update(
      { model, heights: (si) => this.shapeHeights(si), groundAt: this.o.groundAt, waterY: this.o.waterY },
      camera,
      bufferH,
      this.frozenAt === null ? dt : 0,
      night,
    );

    // Tags and blips: the head of each train, the bow of each boat.
    const cands: TagCandidate[] = [];
    const pack = this.pack;
    for (const v of model.vehicles.values()) {
      const a = pack.agencies[v.agency];
      const boat = a.kind === "ferry";
      if (boat ? !boats : !trains) continue;
      const smp = model.sample(v, v.s);
      if (!smp) continue;
      const g = this.o.groundAt(smp.x, smp.z);
      let y = this.o.waterY;
      let under = false;
      if (!boat) {
        const hs = this.shapeHeights(pack.patterns[v.pattern].shape);
        const ry = hs[smp.run][smp.seg] + (hs[smp.run][Math.min(hs[smp.run].length - 1, smp.seg + 1)] - hs[smp.run][smp.seg]) * smp.u;
        under = ry + 3.7 < g - 0.3;
        y = ry + 3.7;
      }
      this.blips.push({ x: smp.x, z: smp.z, color: `#${pack.routes[v.route].color}`, under, boat });
      if (!under) cands.push({ v, x: smp.x, y: boat ? y + 6 : y, z: smp.z });
    }
    this.tags.update(camera, cands, model, now, avoid.map((q) => ({ x: q.x, y: q.y + q.h / 2 })));
  }

  /** Every vehicle's head as lat/lon/height, for pointing a pose at a real train. */
  list(): { route: string; to: string; lat: number; lon: number; y: number; ground: number; level: number; live: boolean }[] {
    const out: ReturnType<TransitLayer["list"]> = [];
    const pack = this.pack;
    const model = this.model;
    if (!pack || !model) return out;
    for (const v of model.vehicles.values()) {
      const smp = model.sample(v, v.s);
      if (!smp) continue;
      const boat = pack.agencies[v.agency].kind === "ferry";
      const hs = boat ? null : this.shapeHeights(pack.patterns[v.pattern].shape);
      const y = hs ? hs[smp.run][smp.seg] + (hs[smp.run][Math.min(hs[smp.run].length - 1, smp.seg + 1)] - hs[smp.run][smp.seg]) * smp.u : this.o.waterY;
      const r = pack.routes[v.route];
      out.push({ route: r.short || r.id, to: v.headsign, ...this.o.origin.toLatLon(smp.x, smp.z), y, ground: this.o.groundAt(smp.x, smp.z), level: smp.lvl, live: v.live });
    }
    return out;
  }

  /** Live and scheduled counts, for the diagnostics line and the shot harness. */
  get stats(): Record<string, number | string> {
    let live = 0, sched = 0;
    for (const v of this.model?.vehicles.values() ?? []) v.live ? live++ : sched++;
    return { live, scheduled: sched, polls: this.polls, error: this.lastError, ...(this.render?.stats ?? {}) };
  }
}
