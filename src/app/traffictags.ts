// Tags on the live aircraft: callsign, type, where it is going, height and
// speed, in the corner-of-the-eye style a game uses for other players.
//
// The same screen-space approach as the landmark labels (app/labels.ts) and
// for the same reasons: legible at any range, never hazed or clipped by the
// depth buffer, and nothing rebuilt per frame. Elements are pooled; a frame
// only moves them and swaps text that changed.
//
// Decluttered nearest first. The sky over New York holds 130 aircraft and
// most of them are a pixel; a tag on every one is a wall of boxes, so only
// the nearest MAX_TAGS that do not overlap are shown, and they fade with
// range so the far ones read as far.
//
// A tag is a control: tapping it opens a card with the airline, the city
// names, the registration and a photo. Only the tag and the card take
// pointer events; the overlay is click-through, so a thumb flying the
// aeroplane anywhere else on a phone is never caught by it.

import * as THREE from "three";
import { parseRoute, routePlausible, type Route, type Track } from "../data/livetraffic";

/** Range past which a tag is clutter. A 34 m airliner is 2 px there. */
const TAG_RANGE_M = 25000;
/** Full strength inside this, fading to TAG_MIN_OPACITY at TAG_RANGE_M. */
const TAG_NEAR_M = 4000;
const TAG_MIN_OPACITY = 0.4;
/** Estimated tag box for the overlap test, px: reading offsetWidth forces layout. */
const TAG_W_PX = 112;
const TAG_H_PX = 38;

interface Tag {
  el: HTMLDivElement;
  cs: HTMLElement;
  type: HTMLElement;
  route: HTMLElement;
  meta: HTMLElement;
  hex: string;
}

export class TrafficTags {
  readonly root: HTMLDivElement;
  private card: HTMLDivElement;
  private pool: Tag[] = [];
  private ndc = new THREE.Vector3();
  private routes = new Map<string, Route | null | "pending">();
  private routeQueue: string[] = [];
  private inFlight = 0;
  private selected: string | null = null;
  private cardHex: string | null = null;
  /**
   * Screen boxes of the tags drawn last frame, centre x/y in CSS px, so the
   * landmark labels can stay out of their way: a tag and a landmark name
   * drawn across each other made both unreadable over LaGuardia.
   */
  readonly rects: { x: number; y: number; w: number; h: number }[] = [];
  /** How many tags may be on screen: raised while spotting at an airport. */
  maxTags = 8;
  visible = true;

  constructor(parent: HTMLElement, private apiBase: URL) {
    this.root = document.createElement("div");
    this.root.className = "ttags";
    parent.append(this.root);
    this.card = document.createElement("div");
    this.card.className = "hud ttag-card";
    this.card.style.display = "none";
    parent.append(this.card);
    this.card.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".ttag-close")) {
        ev.stopPropagation();
        this.select(null);
      }
    });
  }

  private tag(i: number): Tag {
    while (this.pool.length <= i) {
      const el = document.createElement("div");
      el.className = "ttag";
      el.innerHTML = `<div class="l1"><b></b><span></span></div><div class="l2"></div><div class="l3"></div>`;
      const t: Tag = {
        el,
        cs: el.querySelector("b")!,
        type: el.querySelector("span")!,
        route: el.querySelector(".l2")!,
        meta: el.querySelector(".l3")!,
        hex: "",
      };
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.select(t.hex === this.selected ? null : t.hex);
      });
      // A touch that starts on a tag is a tap on the tag, not the start of a
      // drag on the scene underneath it.
      el.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      this.root.append(el);
      this.pool.push(t);
    }
    return this.pool[i];
  }

  private select(hex: string | null): void {
    this.selected = hex;
    this.cardHex = null;
    if (!hex) this.card.style.display = "none";
  }

  /** The route for a callsign, fetched at most once per session. */
  private route(cs: string): Route | null {
    if (!cs) return null;
    const r = this.routes.get(cs);
    if (r === undefined) {
      this.routes.set(cs, "pending");
      this.routeQueue.push(cs);
      this.pump();
      return null;
    }
    return r === "pending" ? null : r;
  }

  /** Two at a time: a sky full of new tags must not become 30 requests at once. */
  private pump(): void {
    while (this.inFlight < 2 && this.routeQueue.length) {
      const cs = this.routeQueue.shift()!;
      this.inFlight++;
      fetch(new URL(`route?cs=${encodeURIComponent(cs)}`, this.apiBase))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => this.routes.set(cs, parseRoute(j)))
        .catch(() => this.routes.set(cs, null))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }

  update(
    camera: THREE.PerspectiveCamera,
    tracks: Iterable<Track>,
    geoOf: (t: Track) => { lat: number; lon: number },
    /** The aircraft being flown, kept clear of tags like the landmark labels do. */
    subject?: THREE.Vector3,
  ): void {
    if (!this.visible) {
      this.rects.length = 0;
      this.root.style.display = "none";
      this.card.style.display = "none";
      return;
    }
    this.root.style.display = "";
    const W = innerWidth;
    const H = innerHeight;
    const cam = camera.position;

    const cand: { t: Track; d: number; x: number; y: number }[] = [];
    let selectedTrack: Track | null = null;
    for (const t of tracks) {
      if (t.info.hex === this.selected) selectedTrack = t;
      if (t.info.cat.startsWith("C")) continue; // airport vehicles: drawn, not tagged
      const p = t.pose;
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      if (d > TAG_RANGE_M) continue;
      // Hung a little above the aircraft, so the tag's pointer sits on it.
      this.ndc.set(p.x, p.y + 6, p.z).project(camera);
      if (this.ndc.z < -1 || this.ndc.z > 1 || Math.abs(this.ndc.x) > 1.05 || Math.abs(this.ndc.y) > 1.05) continue;
      cand.push({ t, d, x: (this.ndc.x * 0.5 + 0.5) * W, y: (-this.ndc.y * 0.5 + 0.5) * H });
    }
    cand.sort((a, b) => (a.t.info.hex === this.selected ? -1 : b.t.info.hex === this.selected ? 1 : a.d - b.d));

    const placed: { x: number; y: number }[] = [];
    this.rects.length = 0;
    if (subject) {
      this.ndc.copy(subject).project(camera);
      if (this.ndc.z > -1 && this.ndc.z < 1) {
        placed.push({ x: (this.ndc.x * 0.5 + 0.5) * W, y: (-this.ndc.y * 0.5 + 0.5) * H });
      }
    }
    let n = 0;
    for (const c of cand) {
      if (n >= this.maxTags) break;
      if (placed.some((p) => Math.abs(p.x - c.x) < TAG_W_PX && Math.abs(p.y - c.y) < TAG_H_PX)) continue;
      placed.push(c);
      this.rects.push({ x: c.x, y: c.y - TAG_H_PX / 2, w: TAG_W_PX, h: TAG_H_PX });
      const tag = this.tag(n++);
      const i = c.t.info;
      tag.hex = i.hex;
      const cs = i.flight || i.reg || i.hex.toUpperCase();
      if (tag.cs.textContent !== cs) tag.cs.textContent = cs;
      const ty = i.type || "";
      if (tag.type.textContent !== ty) tag.type.textContent = ty;
      const g = geoOf(c.t);
      const r = this.route(i.flight);
      const rt = r && routePlausible(r, g.lat, g.lon) ? `${r.from.code} → ${r.to.code}` : "";
      if (tag.route.textContent !== rt) tag.route.textContent = rt;
      tag.route.style.display = rt ? "" : "none";
      const gs = Math.round(i.gsKt ?? 0);
      const meta = i.ground
        ? gs < 2 ? "on the ground" : gs > 50 ? `rolling ${gs} kt` : `taxi ${gs} kt`
        : `${i.altFt !== null ? Math.round(i.altFt / 100) * 100 : "?"} ft · ${Math.round(i.gsKt ?? 0)} kt`;
      const metaFmt = meta.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      if (tag.meta.textContent !== metaFmt) tag.meta.textContent = metaFmt;
      const fade = c.d <= TAG_NEAR_M ? 1 : 1 - ((1 - TAG_MIN_OPACITY) * (c.d - TAG_NEAR_M)) / (TAG_RANGE_M - TAG_NEAR_M);
      tag.el.style.opacity = fade.toFixed(2);
      tag.el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) translate(-50%, -100%)`;
      tag.el.classList.toggle("sel", i.hex === this.selected);
      if (tag.el.style.display) tag.el.style.display = "";
    }
    for (let k = n; k < this.pool.length; k++) {
      if (this.pool[k].el.style.display !== "none") this.pool[k].el.style.display = "none";
      this.pool[k].hex = "";
    }

    this.updateCard(selectedTrack, selectedTrack ? geoOf(selectedTrack) : null);
  }

  private updateCard(t: Track | null, g: { lat: number; lon: number } | null): void {
    if (!this.selected) return;
    if (!t || !g) {
      // It left the feed while the card was open.
      this.select(null);
      return;
    }
    this.card.style.display = "";
    const i = t.info;
    if (this.cardHex !== i.hex) {
      this.cardHex = i.hex;
      this.card.innerHTML =
        `<button class="ttag-close" aria-label="close">×</button>` +
        `<h2></h2><div class="ttag-air"></div><div class="ttag-route"></div>` +
        `<div class="ttag-rows"></div><div class="ttag-photo"></div>`;
      void fetch(new URL(`photo?h=${encodeURIComponent(i.hex)}`, this.apiBase))
        .then((r) => (r.ok ? r.json() : null))
        .then((p: { src?: string; link?: string; by?: string } | null) => {
          if (!p?.src || this.cardHex !== i.hex) return;
          const box = this.card.querySelector(".ttag-photo")!;
          const a = document.createElement("a");
          a.href = p.link ?? "#";
          a.target = "_blank";
          a.rel = "noopener";
          const img = document.createElement("img");
          img.src = p.src;
          img.alt = i.reg;
          const by = document.createElement("small");
          by.textContent = `photo ${p.by ?? ""} / planespotters.net`;
          a.append(img, by);
          box.append(a);
        })
        .catch(() => {});
    }
    const r = this.route(i.flight);
    const ok = r && routePlausible(r, g.lat, g.lon) ? r : null;
    const set = (sel: string, text: string) => {
      const el = this.card.querySelector(sel) as HTMLElement;
      if (el.textContent !== text) el.textContent = text;
    };
    set("h2", `${i.flight || i.reg || i.hex.toUpperCase()}${i.type ? ` · ${i.type}` : ""}`);
    set(".ttag-air", ok?.airline || i.desc || "");
    set(".ttag-route", ok ? `${ok.from.city || ok.from.code} (${ok.from.code}) → ${ok.to.city || ok.to.code} (${ok.to.code})` : "");
    const alt = i.ground ? "on the ground" : i.altFt !== null ? `${Math.round(i.altFt).toLocaleString()} ft` : "";
    const vr = !i.ground && i.vrFpm ? ` ${i.vrFpm > 0 ? "↑" : "↓"}${Math.abs(Math.round(i.vrFpm / 50) * 50).toLocaleString()} fpm` : "";
    set(".ttag-rows", [i.reg && `reg ${i.reg}`, i.desc, `${alt}${vr}`, `${Math.round(i.gsKt ?? 0)} kt`].filter(Boolean).join(" · "));
  }
}
