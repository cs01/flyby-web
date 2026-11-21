// "Escape Pompeii": the eruption as a mission. You are a slave at the bakery
// of Modestus or the Lupanar at a quarter to one on the day the mountain
// opens; you have a lamp to pick up, a town filling with pumice and people,
// roofs that will not hold, and until about seven the next morning to be far
// enough away. The rules and the outcome are sim/eruption.ts, the words
// data/escape.ts, the pictures render/eruption.ts; this is the screens and
// the per-frame glue.
//
// Also the "79 AD eruption" switch: with it on, the eruption follows the
// clock (scrub to 13:00 and the column rises) without any mission running.

import * as THREE from "three";
import {
  clockRate, localHours, resolveEscape, ROOF_LETHAL_M, S4, SURGES_END_H, pumiceDepthM,
  type ClockMode, type EscapeRun, type Outcome, type Route,
} from "../sim/eruption";
import { ENDINGS, GATE_ROUTES, HISTORY_NOTE, STARTS, VENT, clockText, fill, routeFor, type StartId } from "../data/escape";
import type { PompeiiData } from "../data/pompeii";
import type { EruptionView } from "../render/eruption";
import type { Origin } from "../geo";

/** Start: a quarter of an hour before the column. */
const START_H = 12.75;
/** Close enough to a gate to be offered the road. */
const GATE_M = 16;
const PICKUP_M = 2.2;

export interface EscapeHost {
  ui: HTMLElement;
  data: PompeiiData;
  view: EruptionView;
  origin: Origin;
  /** The scene clock as a UTC instant, ms. */
  nowMs: () => number;
  /** Move the scene clock by this many seconds. */
  advance: (seconds: number) => void;
  /** Stand on foot at the nearest standable point to (x, z), facing (fx, fz); the point used, or null. */
  placeOnFoot: (x: number, z: number, fx: number, fz: number) => { x: number; z: number } | null;
  groundAt: (x: number, z: number) => number;
  toast: (s: string) => void;
}

type Mode = "off" | "running" | "gate" | "shelter" | "ending";

export class EscapeUi {
  private readonly panel: HTMLDivElement;
  private readonly toggle: HTMLInputElement;
  private readonly realBox: HTMLInputElement;
  private readonly card: HTMLDivElement;
  private readonly end: HTMLDivElement;
  private readonly indoors: HTMLDivElement;
  private mode: Mode = "off";
  private start: StartId = "bakery";
  private run: EscapeRun = { lampH: null, exit: null, roofH: null };
  private pickup: THREE.Vector3 | null = null;
  private gate: { name: string; x: number; z: number } | null = null;
  private declined: string | null = null;
  private shelterH = 0;
  private lastCollapse = -1;
  private warnedRoofs = false;
  private readonly vent: { x: number; z: number };
  private readonly lampPos = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();

  constructor(private readonly host: EscapeHost) {
    this.vent = host.origin.toWorld(VENT.lat, VENT.lon);

    this.panel = document.createElement("div");
    this.panel.className = "hud hud-eruption";
    this.panel.innerHTML =
      `<h2>79 AD</h2>` +
      `<label class="lyr"><input type="checkbox" data-k="eruption" /><span>79 AD eruption</span></label>` +
      `<label class="lyr"><input type="checkbox" data-k="real" /><span>Real time</span></label>` +
      `<div class="esc-starts"><span>Escape Pompeii</span>` +
      `<button data-start="bakery">from the bakery</button><button data-start="lupanar">from the Lupanar</button></div>`;
    host.ui.appendChild(this.panel);
    this.toggle = this.panel.querySelector('input[data-k="eruption"]') as HTMLInputElement;
    this.realBox = this.panel.querySelector('input[data-k="real"]') as HTMLInputElement;
    this.toggle.checked = host.view.enabled;
    this.toggle.addEventListener("change", () => {
      host.view.enabled = this.toggle.checked;
      if (!this.toggle.checked && this.mode !== "off") this.stop();
      host.toast(this.toggle.checked
        ? "The eruption follows the clock: drag the time past 13:00 to see the column rise"
        : "Pompeii on the eve of the eruption");
    });
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>("button[data-start]")) {
      b.addEventListener("click", () => this.begin(b.dataset.start as StartId));
    }

    this.card = document.createElement("div");
    this.card.className = "hud escape-card";
    this.card.style.display = "none";
    this.card.innerHTML =
      `<div class="e-row"><span class="e-arrow">↑</span><b class="e-goal"></b>` +
      `<button class="e-x" aria-label="Give up">×</button></div>` +
      `<div class="e-sub"></div><div class="e-acts"></div>`;
    (this.card.querySelector(".e-x") as HTMLElement).addEventListener("click", () => this.stop());
    host.ui.appendChild(this.card);

    this.indoors = document.createElement("div");
    this.indoors.className = "escape-indoors";
    this.indoors.style.display = "none";
    host.ui.appendChild(this.indoors);

    this.end = document.createElement("div");
    this.end.className = "escape-end";
    this.end.style.display = "none";
    host.ui.appendChild(this.end);
  }

  get running(): boolean {
    return this.mode !== "off";
  }

  private hour(): number {
    return localHours(this.host.nowMs());
  }

  private setHour(h: number): void {
    this.host.advance((h - this.hour()) * 3600);
  }

  /** Start the story from one of the two houses. */
  begin(id: StartId): void {
    const s = STARTS[id];
    this.start = id;
    this.host.view.enabled = true;
    this.toggle.checked = true;
    this.setHour(START_H);
    const at = this.host.placeOnFoot(s.x, s.z, s.faceX, s.faceZ);
    if (!at) {
      this.host.toast("Could not find the door: the town is not loaded");
      return;
    }
    // The lamp is on the counter by the door, a step toward the street.
    const dx = s.faceX - at.x, dz = s.faceZ - at.z, d = Math.hypot(dx, dz) || 1;
    const px = at.x + (dx / d) * 1.6, pz = at.z + (dz / d) * 1.6;
    this.pickup = new THREE.Vector3(px, this.host.groundAt(px, pz) + 0.9, pz);
    this.run = { lampH: null, exit: null, roofH: null };
    this.gate = null;
    this.declined = null;
    this.warnedRoofs = false;
    this.lastCollapse = -1;
    this.mode = "running";
    this.end.style.display = "none";
    this.indoors.style.display = "none";
    this.card.style.display = "";
    this.host.toast(`${s.title}. ${s.intro}`);
  }

  stop(): void {
    this.mode = "off";
    this.pickup = null;
    this.host.view.pickup = null;
    this.card.style.display = "none";
    this.indoors.style.display = "none";
  }

  /** Per frame. `flying` voids the run: from the air every escape is a straight line. */
  update(dt: number, camera: THREE.PerspectiveCamera, yawRad: number, flying: boolean, mode: ClockMode | null = null): void {
    const v = this.host.view;
    const h = this.hour();
    const clock: ClockMode = mode ?? (this.realBox.checked ? "real" : "story");
    const cam = camera.position;
    // The flame in your right hand, low and a little ahead.
    camera.getWorldDirection(this.fwd);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.lampPos.copy(cam).addScaledVector(this.fwd, 0.8).addScaledVector(this.right, 0.32).addScaledVector(this.up, -0.42);

    if (this.mode === "off") {
      // Free roaming the eruption: you carry a lamp once it is dark, or there is nothing to see.
      v.lamp = v.active && v.state.light < 0.3 ? this.lampPos : null;
      v.pickup = null;
      return;
    }
    if (this.mode === "ending") {
      v.lamp = null;
      return;
    }
    if (flying) {
      this.host.toast("The escape is on foot or by cart: flying ends it");
      this.stop();
      return;
    }
    // The story clock: the scene clock already runs at 1x.
    const rate = clockRate(h, clock);
    if (rate !== 1 && dt > 0) this.host.advance(dt * (rate - 1));

    const hasLamp = this.run.lampH !== null;
    v.lamp = hasLamp ? this.lampPos : null;
    v.pickup = hasLamp ? null : this.pickup;
    if (!hasLamp && this.pickup && Math.hypot(this.pickup.x - cam.x, this.pickup.z - cam.z) < PICKUP_M) {
      this.run.lampH = h;
      this.host.toast("You take the oil lamp. Keep it lit: soon it will be the only light there is");
    }

    const s = v.state;
    if (this.mode === "shelter") {
      const lethalH = this.lethalRoofH();
      if (h >= Math.max(lethalH, this.shelterH + 0.15)) {
        this.run.roofH = h;
        this.finish(resolveEscape(this.run));
        return;
      }
    }
    // The surge in the town.
    if (this.mode !== "shelter" && h >= S4.atH && v.inSurge > 0.8) {
      this.finish(resolveEscape({ ...this.run, exit: null }));
      return;
    }
    if (h >= SURGES_END_H) {
      this.finish(resolveEscape({ ...this.run, exit: null }));
      return;
    }

    const roofs = s.roofFailure > 0;
    if (roofs && !this.warnedRoofs) {
      this.warnedRoofs = true;
      this.host.toast("Roofs are starting to give way under the weight of the pumice. Do not shelter indoors");
    }
    const c = v.newestCollapse();
    if (c && c.startH !== this.lastCollapse) {
      this.lastCollapse = c.startH;
      if (Math.hypot(c.x - cam.x, c.z - cam.z) < 45) this.host.toast("A roof gives way nearby");
    }

    // Which gate you are at, and the nearest one to aim for.
    let near: { name: string; x: number; z: number; d: number } | null = null;
    for (const g of this.host.data.gates) {
      if (!GATE_ROUTES.some((r) => r.gate === g.name)) continue;
      const d = Math.hypot(g.x - cam.x, g.z - cam.z);
      if (!near || d < near.d) near = { ...g, d };
    }
    if (this.mode === "running" && near && near.d < GATE_M && this.declined !== near.name) {
      this.gate = near;
      this.mode = "gate";
    }
    if (this.declined && near && (near.name !== this.declined || near.d > GATE_M * 2)) this.declined = null;
    if (this.mode === "gate" && near && near.d > GATE_M * 1.6) this.mode = "running";

    this.paint(h, cam, yawRad, near, hasLamp);
  }

  /** The hour the pumice on a roof reaches the depth that brings it down. */
  private lethalRoofH(): number {
    let h = 13;
    while (h < S4.atH && pumiceDepthM(h) < ROOF_LETHAL_M) h += 1 / 60;
    return h;
  }

  private gateRoute(name: string, coast = false): Route | null {
    const g = this.host.data.gates.find((q) => q.name === name);
    if (!g) return null;
    return routeFor(name, Math.hypot(g.x - this.vent.x, g.z - this.vent.z), coast);
  }

  private leave(coast: boolean): void {
    if (!this.gate) return;
    const route = this.gateRoute(this.gate.name, coast);
    if (!route) return;
    this.run.exit = { route, h: this.hour() };
    this.finish(resolveEscape(this.run));
  }

  private shelter(): void {
    this.mode = "shelter";
    this.shelterH = this.hour();
    this.indoors.style.display = "";
  }

  private paint(h: number, cam: THREE.Vector3, yawRad: number, near: { name: string; x: number; z: number; d: number } | null, hasLamp: boolean): void {
    const s = this.host.view.state;
    const q = (sel: string) => this.card.querySelector(sel) as HTMLElement;
    let goal = "";
    let target: { x: number; z: number } | null = null;
    const acts: [string, () => void][] = [];
    if (this.mode === "shelter") {
      goal = "You are sheltering indoors";
      acts.push(["Go back out", () => { this.mode = "running"; this.indoors.style.display = "none"; }]);
    } else if (this.mode === "gate" && this.gate) {
      const r = GATE_ROUTES.find((g) => g.gate === this.gate!.name)!;
      if (r.kind === "shore") {
        goal = `${this.gate.name}: the road down to the harbour`;
        acts.push(["Wait at the shore for a boat", () => this.leave(false)]);
        acts.push(["Walk south along the shore to Stabiae", () => this.leave(true)]);
      } else {
        goal = `${this.gate.name}: the road to ${r.toward}`;
        acts.push([`Leave the town toward ${r.toward}`, () => this.leave(false)]);
      }
      acts.push(["Stay in the town", () => { this.declined = this.gate?.name ?? null; this.mode = "running"; }]);
    } else if (!hasLamp && this.pickup) {
      goal = "Take the oil lamp by the door";
      target = this.pickup;
    } else if (h < 13) {
      goal = "Finish your errand. The ground has been shaking for days";
      target = near;
    } else {
      goal = near ? `Get out of the town: nearest gate ${near.name}` : "Get out of the town";
      target = near;
      acts.push(["Shelter indoors", () => this.shelter()]);
    }
    if (q(".e-goal").textContent !== goal) q(".e-goal").textContent = goal;
    const arrow = q(".e-arrow");
    if (target) {
      const bearing = Math.atan2(target.x - cam.x, -(target.z - cam.z));
      arrow.style.visibility = "";
      arrow.style.transform = `rotate(${(bearing - yawRad).toFixed(3)}rad)`;
    } else arrow.style.visibility = "hidden";
    const bits = [clockText(h)];
    if (target) bits.push(`${Math.round(Math.hypot(target.x - cam.x, target.z - cam.z))} m`);
    if (s.pumiceM > 0.005) bits.push(`pumice ${Math.round(s.pumiceM * 100)} cm`);
    if (s.light < 0.3 && !hasLamp) bits.push("too dark to see: find a lamp");
    else if (s.roofFailure > 0) bits.push("roofs failing: keep to the street");
    else if (h >= 13 && h < 14) bits.push("south and east lead away from the mountain");
    const sub = bits.join(" · ");
    if (q(".e-sub").textContent !== sub) q(".e-sub").textContent = sub;
    const el = q(".e-acts");
    const key = acts.map((a) => a[0]).join("|");
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.textContent = "";
      for (const [label, fn] of acts) {
        const b = document.createElement("button");
        b.textContent = label;
        b.addEventListener("click", fn);
        el.appendChild(b);
      }
    }
  }

  /** The ending card. Also used by tools/phoneshots.ts to show one directly. */
  finish(o: Outcome): void {
    this.mode = "ending";
    this.card.style.display = "none";
    this.indoors.style.display = "none";
    this.host.view.pickup = null;
    // The world behind the card is the moment it ended.
    this.setHour(Math.min(o.h, SURGES_END_H));
    const t = ENDINGS[o.ending];
    const exit = this.run.exit;
    const vars = {
      toward: exit?.route.toward ?? "the gate",
      time: clockText(o.h),
      exit: exit ? clockText(exit.h) : "",
      km: (o.distM / 1000).toFixed(1),
      depth: `${Math.round(pumiceDepthM(o.h) * 100)} cm`,
    };
    const start = STARTS[this.start];
    this.end.innerHTML =
      `<div class="e-box"><h2></h2><p class="e-body"></p><p class="e-hist"></p><p class="e-note"></p>` +
      `<div class="e-btns"><button data-a="again">Try again</button><button data-a="close">Back to Pompeii</button></div></div>`;
    (this.end.querySelector("h2") as HTMLElement).textContent = t.title;
    (this.end.querySelector(".e-body") as HTMLElement).textContent = fill(t.body, vars);
    (this.end.querySelector(".e-hist") as HTMLElement).textContent = t.history;
    (this.end.querySelector(".e-note") as HTMLElement).textContent = `${start.title}. ${HISTORY_NOTE}`;
    (this.end.querySelector('[data-a="again"]') as HTMLElement).addEventListener("click", () => this.begin(this.start));
    (this.end.querySelector('[data-a="close"]') as HTMLElement).addEventListener("click", () => {
      this.end.style.display = "none";
      this.stop();
    });
    this.end.style.display = "";
  }

  /** For the shots: jump straight to an ending. */
  forceEnding(ending: "survived" | "road" | "town" | "roof" | "north" | "shore"): void {
    const h = ending === "roof" ? 17.8 : ending === "survived" ? 32.4 : 31.0;
    this.mode = "running";
    this.run = { lampH: 12.8, exit: null, roofH: ending === "roof" ? h : null };
    if (ending !== "town" && ending !== "roof") {
      const gate = ending === "north" ? "Porta di Ercolano" : ending === "shore" ? "Porta Marina" : "Porta di Stabia";
      const route = this.gateRoute(gate);
      if (route) this.run.exit = { route, h: ending === "road" ? 29.5 : 14.5 };
    }
    this.finish(resolveEscape(this.run));
  }

}
