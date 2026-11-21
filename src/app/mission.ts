// The mission HUD: a card naming where to go, how far, which way and how long,
// a column of light over the destination you can see from across the city,
// and the result when you get there. The rules live in sim/mission.ts.

import * as THREE from "three";
import { Mission, pickMission, stars, type Dest, type Leg } from "../sim/mission";
import { formatDistance } from "./units";

const LEG_LABEL: Record<Leg, string> = { walk: "walk", car: "drive", ride: "ride", plane: "fly", drone: "drone" };
const BEAM_H = 420;

function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export interface MissionHost {
  scene: THREE.Scene;
  ui: HTMLElement;
  groundAt: (x: number, z: number) => number;
  standable: (x: number, z: number) => boolean;
  /** Called lazily at each start, because transit stops load after the flight begins. */
  destinations: () => Dest[];
  toast: (s: string) => void;
}

export class MissionUi {
  private mission: Mission | null = null;
  private readonly card: HTMLDivElement;
  private readonly beam: THREE.Mesh;
  private readonly button: HTMLButtonElement;
  /** Bumped by the button and by M; main.ts reads it like the other input counters. */
  requested = 0;

  constructor(private readonly host: MissionHost) {
    this.button = document.createElement("button");
    this.button.className = "hud mission-btn";
    this.button.textContent = "MISSION";
    this.button.addEventListener("click", () => this.requested++);
    host.ui.appendChild(this.button);

    this.card = document.createElement("div");
    this.card.className = "hud mission-card";
    this.card.style.display = "none";
    this.card.innerHTML =
      `<div class="m-to"><span class="m-arrow">↑</span><b></b></div>` +
      `<div class="m-row"><span class="m-dist"></span><span class="m-clock"></span></div>` +
      `<div class="m-legs"></div>`;
    host.ui.appendChild(this.card);

    // Additive and depth-tested but not depth-writing, so it glows over the
    // skyline without hiding the buildings in front of it.
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 6, BEAM_H, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffc94d, transparent: true, opacity: 0.35,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }),
    );
    this.beam.name = "mission";
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    host.scene.add(this.beam);
  }

  get active(): boolean {
    return this.mission?.state === "running";
  }

  /** Start a new mission from where the player stands; false when nothing is in range. */
  start(x: number, z: number): boolean {
    const spec = pickMission(this.host.destinations(), x, z, Math.random, this.host.standable);
    if (!spec) {
      this.host.toast("No destination 1-6 km away from here");
      return false;
    }
    this.mission = new Mission(spec);
    const d = spec.dest;
    this.beam.position.set(d.x, this.host.groundAt(d.x, d.z) + BEAM_H / 2, d.z);
    this.beam.visible = true;
    this.card.style.display = "";
    (this.card.querySelector(".m-to b") as HTMLElement).textContent = d.name;
    const best = this.best(d.name);
    this.host.toast(
      `Get to ${d.name} · ${formatDistance(spec.distM)} · par ${clock(spec.parS)}` +
      `${best ? ` · best ${clock(best)}` : ""} · walk, drive or ride; flying voids it`,
    );
    return true;
  }

  cancel(): void {
    this.mission = null;
    this.beam.visible = false;
    this.card.style.display = "none";
  }

  /** Per frame. `yawRad` is the camera's heading, so the arrow points relative to the view. */
  update(dt: number, leg: Leg, x: number, z: number, yawRad: number): void {
    const m = this.mission;
    if (!m) return;
    const state = m.update(dt, leg, x, z);
    if (state === "void") {
      this.host.toast("Mission void: flying doesn't count. Press MISSION for a new one");
      this.cancel();
      return;
    }
    if (state === "arrived") {
      this.finish(m);
      return;
    }
    const d = m.spec.dest;
    const bearing = Math.atan2(d.x - x, -(d.z - z));
    const rel = bearing - yawRad;
    (this.card.querySelector(".m-arrow") as HTMLElement).style.transform = `rotate(${rel.toFixed(3)}rad)`;
    (this.card.querySelector(".m-dist") as HTMLElement).textContent = formatDistance(m.distanceTo(x, z));
    const over = m.elapsedS > m.spec.parS;
    const c = this.card.querySelector(".m-clock") as HTMLElement;
    c.textContent = `${clock(m.elapsedS)} / ${clock(m.spec.parS)}`;
    c.classList.toggle("over", over);
    const legs = [...m.legs.keys()].map((l) => LEG_LABEL[l]).join(" → ");
    const el = this.card.querySelector(".m-legs") as HTMLElement;
    if (el.textContent !== legs) el.textContent = legs;
  }

  private finish(m: Mission): void {
    const s = stars(m.elapsedS, m.spec.parS);
    const name = m.spec.dest.name;
    const prev = this.best(name);
    const record = !prev || m.elapsedS < prev;
    if (record) this.saveBest(name, m.elapsedS);
    const split = [...m.legs].map(([l, t]) => `${LEG_LABEL[l]} ${clock(t)}`).join(" · ");
    this.host.toast(
      `Arrived at ${name} in ${clock(m.elapsedS)} ${"★".repeat(s)}${"☆".repeat(3 - s)}` +
      `${record ? " · new best" : ""} · ${split}`,
    );
    this.cancel();
  }

  // Best times are a per-viewer convenience; storage may be blocked.
  private best(name: string): number | null {
    try {
      const v = Number(localStorage.getItem(`flyby.mission.${name}`));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  }

  private saveBest(name: string, s: number): void {
    try {
      localStorage.setItem(`flyby.mission.${name}`, String(Math.round(s)));
    } catch {}
  }
}
