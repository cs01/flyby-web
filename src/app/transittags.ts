// Tags on trains and boats: the line's bullet and where it is going ("Q to
// 96 St", "BART Yellow to Antioch", "NYC Ferry East River to Wall St"), in the
// same pooled, decluttered, distance-faded style as the aircraft tags
// (app/traffictags.ts), and a card with the next stops on a tap.
//
// Only what is drawn is tagged: a train under Manhattan has no tag, because a
// tag pointing at a street with nothing on it reads as a bug. It is still on
// the radar and the minimap.

import * as THREE from "three";
import type { TransitModel, Vehicle } from "../data/transit";
import type { TransitPack } from "../data/transitpack";

/** A car is 15 m long; at 6 km it is three pixels and a tag is clutter. */
const TAG_RANGE_M = 6000;
const TAG_NEAR_M = 1500;
const TAG_MIN_OPACITY = 0.45;
const TAG_W_PX = 120;
const TAG_H_PX = 24;
const CARD_STOPS = 6;

interface Tag {
  el: HTMLDivElement;
  bullet: HTMLElement;
  text: HTMLElement;
  key: string;
}

export interface TagCandidate {
  v: Vehicle;
  x: number;
  y: number;
  z: number;
}

/** The short name the bullet carries: Q, 6, Yellow, Brown, ER. */
export function bulletOf(pack: TransitPack, v: Vehicle): string {
  const r = pack.routes[v.route];
  const a = pack.agencies[r.agency];
  if (a.id === "bart") return r.short.split("-")[0];
  if (a.id === "cta") return r.long.replace(/ Line$/, "");
  if (a.id === "mta") return r.short || r.id;
  return r.short || r.id;
}

/** Destination without the CTA's "(Brown Line)" and BART's platform suffixes. */
function cleanName(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
}

/** "Q to 96 St", "BART Yellow to Antioch", "NYC Ferry East River to Wall St". */
export function tagText(pack: TransitPack, v: Vehicle): { bullet: string; line: string } {
  const r = pack.routes[v.route];
  const a = pack.agencies[r.agency];
  const to = cleanName(v.headsign);
  const bullet = bulletOf(pack, v);
  if (a.id === "bart") return { bullet, line: `BART ${bullet} to ${to}` };
  if (a.id === "cta") return { bullet, line: `${bullet} Line to ${to}` };
  if (a.kind === "ferry") return { bullet, line: `${a.name}${r.long && a.id !== "siferry" ? ` ${r.long}` : ""} to ${to}` };
  return { bullet, line: `to ${to}` };
}

export class TransitTags {
  readonly root: HTMLDivElement;
  private card: HTMLDivElement;
  private pool: Tag[] = [];
  private ndc = new THREE.Vector3();
  private selected: string | null = null;
  private cardKey = "";
  private clock: Intl.DateTimeFormat;
  maxTags = 6;
  visible = true;
  /** Screen boxes drawn last frame, for keeping the landmark labels off them. */
  readonly rects: { x: number; y: number; w: number; h: number }[] = [];

  constructor(parent: HTMLElement, private pack: TransitPack) {
    this.root = document.createElement("div");
    this.root.className = "ttags xtags";
    parent.append(this.root);
    this.card = document.createElement("div");
    this.card.className = "hud ttag-card xtag-card";
    this.card.style.display = "none";
    parent.append(this.card);
    this.card.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".ttag-close")) {
        ev.stopPropagation();
        this.select(null);
      }
    });
    this.clock = new Intl.DateTimeFormat("en-US", { timeZone: pack.tz, hour: "numeric", minute: "2-digit" });
  }

  select(key: string | null): void {
    this.selected = key;
    this.cardKey = "";
    if (!key) this.card.style.display = "none";
  }

  private tag(i: number): Tag {
    while (this.pool.length <= i) {
      const el = document.createElement("div");
      el.className = "ttag xtag";
      el.innerHTML = `<div class="l1"><i class="xb"></i><span></span></div>`;
      const t: Tag = { el, bullet: el.querySelector("i")!, text: el.querySelector("span")!, key: "" };
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.select(t.key === this.selected ? null : t.key);
      });
      el.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      this.root.append(el);
      this.pool.push(t);
    }
    return this.pool[i];
  }

  update(camera: THREE.PerspectiveCamera, cands: TagCandidate[], model: TransitModel, now: number, avoid: { x: number; y: number }[]): void {
    if (!this.visible) {
      this.rects.length = 0;
      this.root.style.display = "none";
      this.card.style.display = "none";
      return;
    }
    this.root.style.display = "";
    const W = innerWidth, H = innerHeight;
    const cam = camera.position;
    const list: { c: TagCandidate; d: number; sx: number; sy: number }[] = [];
    for (const c of cands) {
      const d = Math.hypot(c.x - cam.x, c.y - cam.y, c.z - cam.z);
      if (d > TAG_RANGE_M) continue;
      this.ndc.set(c.x, c.y + 5, c.z).project(camera);
      if (this.ndc.z < -1 || this.ndc.z > 1 || Math.abs(this.ndc.x) > 1.05 || Math.abs(this.ndc.y) > 1.05) continue;
      list.push({ c, d, sx: (this.ndc.x * 0.5 + 0.5) * W, sy: (-this.ndc.y * 0.5 + 0.5) * H });
    }
    list.sort((a, b) => (a.c.v.key === this.selected ? -1 : b.c.v.key === this.selected ? 1 : a.d - b.d));
    const placed = avoid.slice();
    this.rects.length = 0;
    let n = 0;
    for (const it of list) {
      if (n >= this.maxTags) break;
      if (placed.some((p) => Math.abs(p.x - it.sx) < TAG_W_PX && Math.abs(p.y - it.sy) < TAG_H_PX * 1.6)) continue;
      placed.push({ x: it.sx, y: it.sy });
      this.rects.push({ x: it.sx, y: it.sy - TAG_H_PX / 2, w: TAG_W_PX, h: TAG_H_PX });
      const tag = this.tag(n++);
      const v = it.c.v;
      tag.key = v.key;
      const { bullet, line } = tagText(this.pack, v);
      const r = this.pack.routes[v.route];
      if (tag.bullet.textContent !== bullet) tag.bullet.textContent = bullet;
      const bg = `#${r.color}`;
      if (tag.bullet.style.background !== bg) {
        tag.bullet.style.background = bg;
        tag.bullet.style.color = `#${r.text}`;
      }
      tag.bullet.classList.toggle("wide", bullet.length > 2);
      const txt = v.live ? line : `${line} · scheduled`;
      if (tag.text.textContent !== txt) tag.text.textContent = txt;
      const fade = it.d <= TAG_NEAR_M ? 1 : 1 - ((1 - TAG_MIN_OPACITY) * (it.d - TAG_NEAR_M)) / (TAG_RANGE_M - TAG_NEAR_M);
      tag.el.style.opacity = fade.toFixed(2);
      tag.el.style.transform = `translate(${it.sx.toFixed(1)}px, ${it.sy.toFixed(1)}px) translate(-50%, -100%)`;
      tag.el.classList.toggle("sel", v.key === this.selected);
      if (tag.el.style.display) tag.el.style.display = "";
    }
    for (let k = n; k < this.pool.length; k++) {
      if (this.pool[k].el.style.display !== "none") this.pool[k].el.style.display = "none";
      this.pool[k].key = "";
    }
    this.updateCard(model, now);
  }

  private updateCard(model: TransitModel, now: number): void {
    if (!this.selected) return;
    const v = model.vehicles.get(this.selected);
    if (!v) {
      this.select(null);
      return;
    }
    this.card.style.display = "";
    const pack = this.pack;
    const r = pack.routes[v.route];
    const a = pack.agencies[r.agency];
    if (this.cardKey !== v.key) {
      this.cardKey = v.key;
      this.card.innerHTML =
        `<button class="ttag-close" aria-label="close">×</button>` +
        `<h2><i class="xb"></i><span></span></h2><div class="ttag-air"></div><div class="ttag-route"></div><div class="ttag-rows xstops"></div>`;
      const b = this.card.querySelector("h2 i") as HTMLElement;
      b.style.background = `#${r.color}`;
      b.style.color = `#${r.text}`;
    }
    const set = (sel: string, text: string) => {
      const el = this.card.querySelector(sel) as HTMLElement;
      if (el.textContent !== text) el.textContent = text;
    };
    const { bullet, line } = tagText(pack, v);
    set("h2 i", bullet);
    set("h2 span", r.long && a.kind !== "ferry" && a.id !== "bart" ? r.long : a.name);
    set(".ttag-air", line);
    set(".ttag-route", v.live ? "live position" : "placed by the timetable");
    const t = now / 1000;
    const rows = v.timeline
      .slice(v.next)
      .filter((s) => s.arr >= t - 30)
      .slice(0, CARD_STOPS)
      .map((s) => {
        const mins = Math.round((s.arr - t) / 60);
        const when = mins <= 0 ? "now" : `${mins} min`;
        return `${cleanName(pack.stops[s.stop].name)}  ${this.clock.format(new Date(s.arr * 1000))} (${when})`;
      });
    const box = this.card.querySelector(".xstops") as HTMLElement;
    const html = rows.map((x) => `<div>${x.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`).join("");
    if (box.innerHTML !== html) box.innerHTML = html;
  }
}
