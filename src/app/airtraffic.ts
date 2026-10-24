// The live-traffic layer, end to end: polls the planes feed, keeps the tracks
// moving (data/livetraffic.ts), draws them (render/airtraffic.ts) and tags
// them (app/traffictags.ts). main.ts holds one of these and calls update()
// once a frame.
//
// POLLING. Every 5 s while the tab is visible and the layer is on, never
// faster: the server answers each cell from a minute-old cache and rate-limits
// upstream, so polling harder buys nothing and costs the server. A hidden tab
// stops polling entirely and the next visible frame polls at once.
//
// The poll is centred on the city origin, or on the airport while spotting.
// The server's radius is 40 nm, so either centre covers everything the
// terrain can show, and keeping the centre fixed keeps every viewer of a city
// in the same cache cell.
//
// SCREENSHOTS. `?shot` leaves the layer off so a pose renders the same pixels
// on every run. `?traffic=<fixture>` (dev only) replays
// test/fixtures/<fixture>.json instead of the live feed and freezes the clock
// at its `now`, which makes the traffic in a shot as fixed as the buildings.

import * as THREE from "three";
import type { Origin } from "../geo";
import { LiveTraffic, parseFeed, type PlaneFeed } from "../data/livetraffic";
import { AirTraffic } from "../render/airtraffic";
import type { AircraftModel } from "../render/aircraftmodel";
import { TrafficTags } from "./traffictags";

const POLL_MS = 5000;

export interface AirTrafficOptions {
  scene: THREE.Scene;
  ui: HTMLElement;
  model: AircraftModel;
  origin: Origin;
  groundAt: (x: number, z: number) => number;
  shotMode: boolean;
}

/** Same-origin in production (chadsmith.dev/flyby -> /planes); the dev server proxies it. */
export function planesApi(): URL {
  return new URL("/planes/api/", location.href);
}

export class AirTrafficLayer {
  readonly traffic: LiveTraffic;
  readonly render: AirTraffic;
  readonly tags: TrafficTags;
  /** False when the URL turned the layer off: no polling, no drawing. */
  readonly available: boolean;
  private centre: { lat: number; lon: number };
  private api = planesApi();
  private lastPoll = -Infinity;
  private polling = false;
  /** Fixed epoch ms when replaying a fixture; null for the live clock. */
  private frozenAt: number | null = null;
  /** Answers received, for the diagnostics line. */
  polls = 0;
  lastError = "";

  constructor(private o: AirTrafficOptions) {
    const params = new URLSearchParams(location.search);
    const fixture = import.meta.env.DEV ? params.get("traffic") : null;
    this.available = !params.has("notraffic") && (!o.shotMode || fixture !== null);
    this.centre = { lat: o.origin.lat, lon: o.origin.lon };
    this.traffic = new LiveTraffic(o.origin, { groundAt: o.groundAt });
    this.render = new AirTraffic(o.model);
    this.tags = new TrafficTags(o.ui, this.api);
    o.scene.add(this.render.group);

    if (this.available && fixture && fixture !== "live") {
      void fetch(`/test/fixtures/${encodeURIComponent(fixture)}.json`)
        .then((r) => r.json())
        .then((j) => {
          const feed = parseFeed(j);
          if (!feed) throw new Error("not a planes feed");
          this.frozenAt = feed.now;
          this.traffic.ingest(feed, feed.now);
        })
        .catch((e: unknown) => {
          this.lastError = String(e);
          console.error("[flyby] traffic fixture failed", e);
        });
    }
    // Back from a hidden tab: poll on the next frame rather than up to 5 s on.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.lastPoll = -Infinity;
    });
  }

  /** Re-centre the poll (spotting) and say how many tags may show. */
  focus(lat: number, lon: number, maxTags: number): void {
    this.centre = { lat, lon };
    this.tags.maxTags = maxTags;
    this.lastPoll = -Infinity;
  }

  private poll(): void {
    if (this.polling || this.frozenAt !== null) return;
    this.polling = true;
    const url = new URL(`planes?lat=${this.centre.lat.toFixed(3)}&lon=${this.centre.lon.toFixed(3)}`, this.api);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`planes ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const feed: PlaneFeed | null = parseFeed(j);
        if (!feed) throw new Error("planes: not a feed");
        this.traffic.ingest(feed, Date.now());
        this.polls++;
        this.lastError = "";
      })
      .catch((e: unknown) => {
        this.lastError = String(e);
      })
      .finally(() => {
        this.polling = false;
      });
  }

  /**
   * One frame. `on` is the layer switch; `night` is the scene's darkness for
   * the lights; `subject` is the machine being flown, kept clear of tags.
   */
  update(
    camera: THREE.PerspectiveCamera,
    bufferH: number,
    dt: number,
    night: number,
    on: boolean,
    subject?: THREE.Vector3,
  ): void {
    const show = on && this.available;
    this.render.group.visible = show;
    this.tags.visible = show;
    if (!show) {
      this.tags.update(camera, [], () => ({ lat: 0, lon: 0 }));
      return;
    }
    const now = this.frozenAt ?? Date.now();
    if (this.frozenAt === null && document.visibilityState === "visible" && now - this.lastPoll >= POLL_MS) {
      this.lastPoll = now;
      this.poll();
    }
    this.traffic.step(now);
    const tracks = this.traffic.tracks.values();
    this.render.update(tracks, camera, innerHeight, bufferH, this.frozenAt === null ? dt : 0, night);
    this.tags.update(camera, this.traffic.tracks.values(), (t) => this.o.origin.toLatLon(t.pose.x, t.pose.z), subject);
  }
}
