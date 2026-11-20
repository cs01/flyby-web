// Getting on a train, tram, bus or ferry on foot and riding it along its real
// route. The frame maths and the rules are in sim/ride.ts; this keeps the
// rider attached to a vehicle in the transit model, draws the cabin round them,
// and puts the hint and the route banner on screen.
//
// main.ts calls take() with the frame's walking input instead of handing it to
// the drone, and update() AFTER transit.update, so the camera and the car it is
// in come from the same model step; a frame earlier the car mesh runs a third
// of a metre ahead of the eye at line speed.

import * as THREE from "three";
import type { Drone, DroneInput } from "../sim/drone";
import type { CarPose, Vehicle } from "../data/transit";
import type { TransitLayer } from "./transit";
import type { AircraftModel } from "../render/aircraftmodel";
import { CabinRender } from "../render/cabin";
import {
  canAlight,
  deckFor,
  distToDeck,
  relYawDeg,
  riderEye,
  stepRider,
  toLocal,
  toWorld,
  worldYawDeg,
  clampToDeck,
  type Deck,
  type RideInput,
  type RideKind,
  type Rider,
  type Vec3,
} from "../sim/ride";
import { WALK_EYE_M } from "../sim/drone";

/** Plan distance from the person to a car's outline that still lets them board. */
export const BOARD_RANGE_M = 8;
/**
 * And vertically, feet to floor. Generous on purpose: there are no el
 * platforms to climb to, so the L is boarded from the street under it. A
 * subway car is not, because it is not drawn (carUnderground) and is skipped.
 */
const BOARD_RISE_M = 12;
/** How often the hint looks for something to board, s. */
const SCAN_S = 0.25;

export interface RideOptions {
  scene: THREE.Scene;
  ui: HTMLElement;
  model: AircraftModel;
  transit: TransitLayer;
  drone: Drone;
  groundAt: (x: number, z: number) => number;
  /** The nearest dry spot to stand on, as walk mode finds one. */
  standable: (x: number, z: number) => { x: number; z: number } | null;
  toast: (text: string) => void;
}

export class RideController {
  private key: string | null = null;
  private car = 0;
  private kind: RideKind = "rail";
  private deck: Deck = deckFor("rail");
  private famKey = "";
  private readonly rider: Rider = { lx: 0, lz: 0, relYawDeg: 0, pitchDeg: 0 };
  private readonly inp: RideInput = { forward: 0, strafe: 0, yaw: 0, pitch: 0, boost: 0, lookYawDeg: 0, lookPitchDeg: 0 };
  private readonly pose: CarPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hidden: false };
  /** The last good pose, for getting off when the vehicle leaves the model. */
  private readonly last: CarPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hidden: false };
  private readonly scanPose: CarPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hidden: false };
  private readonly eye: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly loc: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly cabin: CabinRender;
  private scanT = 0;
  /** The best thing to board this scan, or null. */
  private near: { key: string; car: number } | null = null;
  private pressed = 0;
  private hint: HTMLButtonElement;
  private banner: HTMLDivElement;
  private bannerTitle: HTMLElement;
  private bannerNext: HTMLElement;
  private shownHint = "";
  private shownTitle = "";
  private shownNext = "";

  constructor(private o: RideOptions) {
    this.cabin = new CabinRender(o.model);
    o.scene.add(this.cabin.group);
    // A button, so a phone can tap it; F does the same on a keyboard.
    this.hint = document.createElement("button");
    this.hint.className = "ride-hint";
    this.hint.style.display = "none";
    this.hint.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pressed++;
    });
    this.banner = document.createElement("div");
    this.banner.className = "street-sign ride-banner";
    this.banner.style.display = "none";
    this.banner.innerHTML = "<b></b><span></span>";
    this.bannerTitle = this.banner.firstElementChild as HTMLElement;
    this.bannerNext = this.banner.lastElementChild as HTMLElement;
    this.banner.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.pressed++;
    });
    o.ui.append(this.hint, this.banner);
    // Dev only: a handle for standing someone beside a train from the console.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__flybyRide = this;
  }

  /** Dev only: stand the walker `m` metres to the side of car `car` of the vehicle `key`. */
  devStandBeside(key: string, car = 0, m = 4): boolean {
    const v = this.o.transit.model?.vehicles.get(key);
    if (!v || !this.o.transit.poseOf(v, car, this.pose)) return false;
    const deck = deckFor(this.o.transit.pack!.agencies[v.agency].kind);
    toWorld(this.pose, deck.hx + m, 0, 0, this.loc);
    const d = this.o.drone;
    d.position.set(this.loc.x, this.o.groundAt(this.loc.x, this.loc.z) + WALK_EYE_M, this.loc.z);
    d.yawDeg = worldYawDeg(270, this.pose.yaw);
    return true;
  }

  /** Dev only: the keys of drawn vehicles, nearest first. */
  devKeys(): string[] {
    const m = this.o.transit.model;
    if (!m) return [];
    return [...m.vehicles.values()].filter((v) => this.o.transit.drawn(v)).map((v) => v.key);
  }

  get riding(): boolean {
    return this.key !== null;
  }

  /** The F key or a tap: board what is in range, or get off. */
  press(): void {
    this.pressed++;
  }

  /** This frame's walking input, used inside the vehicle instead of by the drone. */
  take(di: DroneInput): void {
    const t = this.inp;
    t.forward = di.forward;
    t.strafe = di.strafe;
    t.yaw = di.yaw;
    t.pitch = di.pitch;
    t.boost = di.boost;
    t.lookYawDeg += di.lookYawDeg;
    t.lookPitchDeg += di.lookPitchDeg;
  }

  /** Board the nearest vehicle in range, if any; true when boarded. */
  tryBoard(): boolean {
    const n = this.scan();
    if (!n) return false;
    const model = this.o.transit.model!;
    const v = model.vehicles.get(n.key);
    if (!v || !this.o.transit.poseOf(v, n.car, this.pose)) return false;
    const d = this.o.drone;
    this.key = n.key;
    this.car = n.car;
    this.setDeck(v);
    // Step in at the nearest point of the deck, still facing the way you were.
    toLocal(this.pose, d.position.x, this.pose.y + this.deck.floor + WALK_EYE_M, d.position.z, this.loc);
    clampToDeck(this.deck, this.loc.x, this.loc.z, this.loc);
    this.rider.lx = this.loc.x;
    this.rider.lz = this.loc.z;
    this.rider.relYawDeg = relYawDeg(d.yawDeg, this.pose.yaw);
    this.rider.pitchDeg = d.pitchDeg;
    this.inp.lookYawDeg = this.inp.lookPitchDeg = 0;
    this.copyPose(this.last, this.pose);
    const pack = this.o.transit.pack!;
    const r = pack.routes[v.route];
    this.o.toast(`On the ${r.short || r.long} to ${v.headsign} · F at a stop to get off`);
    return true;
  }

  /**
   * Once a frame, after transit.update. `onFoot` is walk mode; anything that
   * takes the person out of it (N, V, G, the mode bar) ends the ride where it
   * stands. Returns true when it placed the drone (and so the camera).
   */
  update(dt: number, onFoot: boolean): boolean {
    const pressed = this.pressed > 0;
    this.pressed = 0;
    if (!onFoot) {
      if (this.key) this.end();
      this.setHint(null);
      return false;
    }
    if (!this.key) {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = SCAN_S;
        this.near = this.scan();
      }
      if (pressed) {
        if (!this.tryBoard()) this.o.toast(`Nothing to board within ${BOARD_RANGE_M} m`);
      }
      if (!this.key) {
        this.setHint(this.near);
        return false;
      }
    }
    this.setHint(null);
    const transit = this.o.transit;
    const v = transit.model?.vehicles.get(this.key!);
    // Trip over or the feed dropped it: off where it last was.
    if (!v || !transit.poseOf(v, this.car, this.pose)) {
      this.alight(this.last, null);
      this.o.toast("End of the line");
      return false;
    }
    if (dt > 0) stepRider(this.rider, this.inp, this.deck, dt);
    this.inp.lookYawDeg = this.inp.lookPitchDeg = 0;
    this.copyPose(this.last, this.pose);
    const stop = v.timeline[v.next];
    const atStop = canAlight(v.speed, v.s, stop ? stop.s : null);
    if (pressed) {
      if (atStop) {
        this.alight(this.pose, v);
        return false;
      }
      this.o.toast("Can't get off while moving");
    }
    const d = this.o.drone;
    riderEye(this.pose, this.rider, this.deck, this.eye);
    if (dt > 0) d.velocity.set((this.eye.x - d.position.x) / dt, 0, (this.eye.z - d.position.z) / dt);
    d.position.set(this.eye.x, this.eye.y, this.eye.z);
    d.yawDeg = worldYawDeg(this.rider.relYawDeg, this.pose.yaw);
    d.pitchDeg = this.rider.pitchDeg;
    d.rollDeg = 0;
    this.cabin.show(this.famKey, this.deck, this.kind !== "ferry", this.pose.x, this.pose.y, this.pose.z, this.pose.yaw, this.pose.pitch);
    // A few times a second: the text is minutes and a stop name.
    this.scanT -= dt;
    if (this.scanT <= 0 || pressed) {
      this.scanT = SCAN_S;
      this.setBanner(v, atStop);
    }
    return true;
  }

  private setDeck(v: Vehicle): void {
    const transit = this.o.transit;
    const pack = transit.pack!;
    const rolling = transit.rollingOf(v);
    this.kind = pack.agencies[v.agency].kind;
    this.deck = deckFor(this.kind, rolling.len, rolling.width);
    this.famKey = `${this.kind}-${rolling.len}-${rolling.width}`;
  }

  private copyPose(dst: CarPose, src: CarPose): void {
    dst.x = src.x;
    dst.y = src.y;
    dst.z = src.z;
    dst.yaw = src.yaw;
    dst.pitch = src.pitch;
    dst.hidden = src.hidden;
  }

  /**
   * Out onto dry ground: beside the car, on whichever side is not water, at
   * the stop itself for a ferry (whose sides are water), and failing those
   * the nearest dry ground, as walk mode finds it.
   */
  private alight(p: CarPose, v: Vehicle | null): void {
    const d = this.o.drone;
    const pack = this.o.transit.pack;
    const dry = (x: number, z: number) => !(d.blocked?.(x, z) ?? false);
    let spot: { x: number; z: number } | null = null;
    if (this.kind !== "ferry") {
      for (const side of [1, -1]) {
        toWorld(p, side * (this.deck.hx + 1.2), 0, this.rider.lz, this.loc);
        if (dry(this.loc.x, this.loc.z)) {
          spot = { x: this.loc.x, z: this.loc.z };
          break;
        }
      }
    } else if (v && pack) {
      const st = pack.stops[v.timeline[v.next]?.stop ?? -1];
      if (st && dry(st.x, st.z)) spot = { x: st.x, z: st.z };
      else if (st) spot = this.o.standable(st.x, st.z);
    }
    spot ??= this.o.standable(p.x, p.z);
    const facing = worldYawDeg(this.rider.relYawDeg, p.yaw);
    this.end();
    if (!spot) return; // Nowhere dry within 4 km: stay on foot where the eye is.
    d.enterWalk(spot.x, spot.z, this.o.groundAt(spot.x, spot.z), facing);
  }

  private end(): void {
    this.key = null;
    this.cabin.show(null, null, false, 0, 0, 0, 0, 0);
    this.banner.style.display = "none";
    this.shownTitle = this.shownNext = "";
  }

  /** The nearest drawn car in range of the person's feet, or null. */
  private scan(): { key: string; car: number } | null {
    const transit = this.o.transit;
    const model = transit.model;
    const pack = transit.pack;
    if (!model || !pack) return null;
    const d = this.o.drone;
    const fx = d.position.x, fy = d.position.y - WALK_EYE_M, fz = d.position.z;
    let best: { key: string; car: number } | null = null;
    let bestD = BOARD_RANGE_M;
    const p = this.scanPose;
    for (const v of model.vehicles.values()) {
      if (!transit.drawn(v)) continue;
      const rolling = transit.rollingOf(v);
      const head = model.sample(v, v.s);
      if (!head) continue;
      const reach = rolling.cars * rolling.len + rolling.len + BOARD_RANGE_M;
      if (Math.abs(head.x - fx) > reach || Math.abs(head.z - fz) > reach) continue;
      const kind = pack.agencies[v.agency].kind;
      const deck = deckFor(kind, rolling.len, rolling.width);
      for (let i = 0; i < rolling.cars; i++) {
        if (!transit.poseOf(v, i, p) || p.hidden) continue;
        if (Math.abs(p.y + deck.floor - fy) > BOARD_RISE_M) continue;
        toLocal(p, fx, p.y + deck.floor, fz, this.loc);
        const dd = distToDeck(deck, this.loc.x, this.loc.z);
        if (dd <= bestD) {
          bestD = dd;
          best = { key: v.key, car: i };
        }
      }
    }
    return best;
  }

  private setHint(n: { key: string; car: number } | null): void {
    let text = "";
    if (n) {
      const v = this.o.transit.model?.vehicles.get(n.key);
      const pack = this.o.transit.pack;
      if (v && pack) {
        const r = pack.routes[v.route];
        text = `F · board the ${r.short || r.long} to ${v.headsign}`;
      }
    }
    if (text === this.shownHint) return;
    this.shownHint = text;
    this.hint.textContent = text;
    this.hint.style.display = text ? "" : "none";
  }

  private setBanner(v: Vehicle, atStop: boolean): void {
    const pack = this.o.transit.pack!;
    const r = pack.routes[v.route];
    const title = `${r.short || r.long} · to ${v.headsign}`;
    const stop = v.timeline[v.next];
    const name = stop ? pack.stops[stop.stop]?.name ?? "" : "";
    let next: string;
    if (atStop) next = `At ${name} · F to get off`;
    else {
      const min = stop ? Math.max(0, Math.ceil((stop.arr - this.o.transit.now / 1000) / 60)) : 0;
      next = `Next: ${name} · ${min} min`;
    }
    if (this.banner.style.display === "none") this.banner.style.display = "";
    if (title !== this.shownTitle) this.bannerTitle.textContent = this.shownTitle = title;
    if (next !== this.shownNext) this.bannerNext.textContent = this.shownNext = next;
  }
}
