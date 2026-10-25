// Plane spotting: a radar of the live traffic, a target to chase, and a
// camera instead of a gun. Get a real aircraft into the middle of the frame,
// close enough, for a second, and it goes in the logbook.
//
// Optional and quiet by design. It never takes the controls, it draws only a
// small radar, a marker on the target and a logbook button, and none of them
// sits under the flying thumb: the radar is in the bottom-right corner the
// minimap already owns, and only its own blips take taps. `?shot` has no
// traffic and so no game. The rules live in data/spotting.ts and are gated by
// test/spotting.check.ts.

import * as THREE from "three";
import type { AirTrafficLayer } from "./airtraffic";
import type { Track } from "../data/livetraffic";
import { routePlausible } from "../data/livetraffic";
import { airlineOf } from "../data/aircrafttypes";
import { framed, Hold, Logbook, rarityOf, spotRangeM, TIER_POINTS, type Spot, type Store, type Tier } from "../data/spotting";
import { planesApi } from "./airtraffic";
import type { TransitBlip } from "./transit";

/**
 * Radar ranges, metres to the rim. The smallest that holds the nearest
 * RADAR_FIT aircraft is used: 20 km holds a city's approach paths, but at an
 * airport the forty aircraft on the apron all sat on the centre pixel.
 */
const RADAR_STEPS = [2000, 5000, 10000, 20000];
const RADAR_FIT = 5;
/** Device pixels across the radar canvas; CSS size is set in style.css. */
const RADAR_PX = 260;
/** Callsigns printed on the radar: the nearest few, or it becomes a list. */
const RADAR_LABELS = 3;
/** The automatic target is re-picked this often, so it does not flicker. */
const RETARGET_S = 2;
/** Beyond this the nearest unspotted aircraft is not worth chasing. */
const CHASE_MAX_M = 30000;

const TIER_LABEL: Record<Tier, string> = { common: "common", uncommon: "uncommon", rare: "rare", legendary: "legendary" };

function localStore(): Store | null {
  try {
    const ls = window.localStorage;
    return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) };
  } catch {
    return null;
  }
}

export class SpotGame {
  readonly book = new Logbook(localStore());
  private radar: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private marker: HTMLDivElement;
  private markerLabel: HTMLElement;
  private flash: HTMLDivElement;
  private card: HTMLDivElement;
  private btn: HTMLButtonElement;
  private log: HTMLDivElement;
  private hold = new Hold();
  private famous = new Set<string>();
  private target: string | null = null;
  private retargetIn = 0;
  private radarClock = 0;
  private cardTimer = 0;
  private blips: { hex: string; px: number; py: number }[] = [];
  private ndc = new THREE.Vector3();
  private visible = true;

  /** Trains and boats, drawn under the aircraft as small squares. */
  transit: TransitBlip[] = [];

  /** The aircraft for the minimap's own close-range layer. */
  readonly near: { x: number; z: number; headingDeg: number; target: boolean }[] = [];

  constructor(ui: HTMLElement, private layer: AirTrafficLayer, private cityName: () => string) {
    this.radar = document.createElement("canvas");
    this.radar.className = "spot-radar";
    this.radar.width = RADAR_PX;
    this.radar.height = RADAR_PX;
    this.g = this.radar.getContext("2d")!;
    ui.append(this.radar);
    this.radar.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      const r = this.radar.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * RADAR_PX;
      const y = ((ev.clientY - r.top) / r.height) * RADAR_PX;
      let best: string | null = null;
      let bd = 26; // device px: a fingertip on a 104 px disc
      for (const b of this.blips) {
        const d = Math.hypot(b.px - x, b.py - y);
        if (d < bd) {
          bd = d;
          best = b.hex;
        }
      }
      if (best) {
        this.target = best;
        this.retargetIn = 30;
        this.layer.tags.select(best);
      }
    });

    this.marker = document.createElement("div");
    this.marker.className = "spot-tgt";
    this.marker.innerHTML = `<div class="ring"></div><div class="arrow"></div><span></span>`;
    this.markerLabel = this.marker.querySelector("span")!;
    ui.append(this.marker);

    this.flash = document.createElement("div");
    this.flash.className = "spot-flash";
    ui.append(this.flash);

    this.card = document.createElement("div");
    this.card.className = "hud spot-card";
    this.card.style.display = "none";
    this.card.addEventListener("click", () => (this.card.style.display = "none"));
    ui.append(this.card);

    this.btn = document.createElement("button");
    this.btn.className = "spot-btn";
    this.btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.toggleLog();
    });
    ui.append(this.btn);

    this.log = document.createElement("div");
    this.log.className = "hud spot-log";
    this.log.style.display = "none";
    this.log.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".spot-close")) this.toggleLog();
    });
    ui.append(this.log);
    this.paintButton();

    void fetch(new URL("famous", planesApi()))
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { all?: { reg?: string }[] } | null) => {
        for (const f of j?.all ?? []) if (f.reg) this.famous.add(f.reg.toUpperCase());
      })
      .catch(() => {});
  }

  private paintButton(): void {
    this.btn.textContent = `LOG ${this.book.spots.length} · ${this.book.score}`;
  }

  private toggleLog(): void {
    const open = this.log.style.display === "none";
    this.log.style.display = open ? "" : "none";
    if (!open) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const rows = this.book.spots
      .slice(0, 60)
      .map(
        (s) =>
          `<li class="t-${s.tier}"><b>${esc(s.flight || s.reg || s.hex)}</b> ${esc(s.type)} <i>${esc(s.airlineName || s.airline)}</i>` +
          `<small>${esc(s.city)} · ${new Date(s.t).toLocaleDateString()} · +${s.points}</small></li>`,
      )
      .join("");
    const counts = (k: "type" | "airline") =>
      this.book
        .countBy(k)
        .slice(0, 8)
        .map(([n, c]) => `${esc(n)} ${c}`)
        .join(" · ");
    this.log.innerHTML =
      `<button class="spot-close" aria-label="close">×</button>` +
      `<h2>Logbook</h2>` +
      `<div class="spot-score">${this.book.spots.length} airframes · ${this.book.score} points</div>` +
      (this.book.spots.length
        ? `<div class="spot-counts"><b>Types</b> ${counts("type")}</div><div class="spot-counts"><b>Airlines</b> ${counts("airline")}</div><ul>${rows}</ul>`
        : `<p class="spot-empty">Nothing yet. Fly close to the aircraft the radar's yellow ring marks, put it in the middle of the screen and hold it there for a second.</p>`);
  }

  /** The target hex: the one picked by tap, else the nearest unspotted. */
  private pickTarget(tracks: Track[], cam: THREE.Vector3, dt: number): Track | null {
    const sel = this.layer.tags.selectedHex;
    if (sel) this.target = sel;
    this.retargetIn -= dt;
    let cur = this.target ? tracks.find((t) => t.info.hex === this.target) ?? null : null;
    if (cur && this.book.has(cur.info.hex) && cur.info.hex !== sel) cur = null;
    if (!cur || (this.retargetIn <= 0 && cur.info.hex !== sel)) {
      this.retargetIn = RETARGET_S;
      let best: Track | null = null;
      let bd = CHASE_MAX_M;
      for (const t of tracks) {
        if (this.book.has(t.info.hex) || t.info.cat.startsWith("C")) continue;
        const d = Math.hypot(t.pose.x - cam.x, t.pose.y - cam.y, t.pose.z - cam.z);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      // Keep the current one unless the new one is a third nearer: a target
      // that swaps every two seconds between two equidistant jets is no target.
      if (cur && best && best !== cur) {
        const dc = Math.hypot(cur.pose.x - cam.x, cur.pose.y - cam.y, cur.pose.z - cam.z);
        if (bd > dc * 0.67) best = cur;
      }
      cur = best ?? cur;
      if (cur?.info.hex !== this.target) this.hold.reset();
      this.target = cur?.info.hex ?? null;
    }
    return cur;
  }

  update(
    camera: THREE.PerspectiveCamera,
    dt: number,
    /** What is being flown: its position and heading, for the radar. */
    me: { x: number; y: number; z: number; headingDeg: number },
    on: boolean,
  ): void {
    const show = on && this.layer.available;
    if (show !== this.visible) {
      this.visible = show;
      for (const el of [this.radar, this.btn]) el.style.display = show ? "" : "none";
      if (!show) {
        this.marker.style.display = "none";
        this.log.style.display = "none";
      }
    }
    if (!show) return;
    const tracks = [...this.layer.traffic.tracks.values()];
    const cam = camera.position;
    const tgt = this.pickTarget(tracks, cam, dt);

    this.radarClock += dt;
    if (this.radarClock > 0.1) {
      this.radarClock = 0;
      this.drawRadar(tracks, me, tgt);
    }

    // --- the target marker, and the photo --------------------------------
    if (!tgt) {
      this.marker.style.display = "none";
      this.hold.reset();
    } else {
      const p = tgt.pose;
      const dist = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      this.ndc.set(p.x, p.y, p.z).project(camera);
      const span = this.layer.render.spanFor(tgt);
      const ok = framed({ distM: dist, spanM: span, ndcX: this.ndc.x, ndcY: this.ndc.y, ndcZ: this.ndc.z });
      const already = this.book.has(tgt.info.hex);
      if (!already && this.hold.update(dt, ok)) this.take(tgt, dist);
      this.placeMarker(tgt, dist, span, me.y);
    }
    if (this.cardTimer > 0) {
      this.cardTimer -= dt;
      if (this.cardTimer <= 0) this.card.style.display = "none";
    }
  }

  private placeMarker(t: Track, dist: number, span: number, myY: number): void {
    const W = innerWidth;
    const H = innerHeight;
    const n = this.ndc;
    // Behind the camera the projection mirrors through the centre; flip it so
    // the edge arrow points the way to turn.
    const behind = n.z > 1;
    let x = behind ? -n.x : n.x;
    let y = behind ? -n.y : n.y;
    const onScreen = !behind && Math.abs(x) < 0.95 && Math.abs(y) < 0.92;
    let angle = 0;
    if (!onScreen) {
      // Pushed to the screen edge along the direction to the target.
      const m = Math.max(Math.abs(x), Math.abs(y), 1e-6);
      // 90 px short of the right edge, where the throttle sits on a phone.
      x = (x / m) * (x > 0 ? 1 - 180 / W : 0.9);
      y = (y / m) * 0.8;
      angle = Math.atan2(-y, x);
    }
    const px = (x * 0.5 + 0.5) * W;
    const py = (-y * 0.5 + 0.5) * H;
    this.marker.style.display = "";
    this.marker.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
    this.marker.classList.toggle("edge", !onScreen);
    this.marker.classList.toggle("inrange", dist <= spotRangeM(span));
    this.marker.classList.toggle("spotted", this.book.has(t.info.hex));
    (this.marker.querySelector(".arrow") as HTMLElement).style.transform = `rotate(${(-angle * 180) / Math.PI}deg)`;
    this.marker.style.setProperty("--hold", `${Math.round(this.hold.progress * 100)}%`);
    const dy = t.pose.y - myY;
    const km = dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`;
    const alt = Math.abs(dy) < 30 ? "level" : `${dy > 0 ? "↑" : "↓"}${Math.round(Math.abs(dy) / 0.3048 / 100) * 100} ft`;
    const label = `${t.info.flight || t.info.reg || t.info.type} · ${km} · ${alt}`;
    if (this.markerLabel.textContent !== label) this.markerLabel.textContent = label;
  }

  private take(t: Track, dist: number): void {
    const i = t.info;
    const tier = rarityOf({ hex: i.hex, type: i.type, cat: i.cat, reg: i.reg, mil: i.mil }, this.famous);
    const ll = this.layer.traffic.origin.toLatLon(t.pose.x, t.pose.z);
    const r = this.layer.tags.route(i.flight);
    const route = r && routePlausible(r, ll.lat, ll.lon) ? r : null;
    const spot: Spot = {
      hex: i.hex,
      flight: i.flight,
      reg: i.reg,
      type: i.type,
      desc: i.desc,
      // Keyed by the ICAO prefix so "AAL" from a callsign and "American
      // Airlines" from a route lookup are one airline in the counts; the name
      // is kept for display.
      airline: airlineOf(i.flight) || (i.mil ? "military" : "private"),
      airlineName: route?.airline || "",
      route: route ? `${route.from.code} → ${route.to.code}` : "",
      altFt: i.altFt ?? 0,
      distM: Math.round(dist),
      city: this.cityName(),
      t: Date.now(),
      tier,
      points: TIER_POINTS[tier],
    };
    const res = this.book.add(spot);
    this.flash.classList.remove("go");
    void this.flash.offsetWidth; // restart the animation
    this.flash.classList.add("go");
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const badges = [
      res.added ? `<em class="new">NEW!</em>` : "",
      res.newType ? `<em>first ${esc(spot.type)}</em>` : "",
      res.newAirline ? `<em>first ${esc(spot.airline)}</em>` : "",
    ].join("");
    this.card.className = `hud spot-card t-${tier}`;
    this.card.innerHTML =
      `<div class="spot-tier">${TIER_LABEL[tier]} · +${res.points}</div>` +
      `<h2>${esc(spot.flight || spot.reg || spot.hex.toUpperCase())} <span>${esc(spot.type)}</span></h2>` +
      `<div class="spot-badges">${badges}</div>` +
      `<div>${spot.airline !== "private" ? esc(spot.airlineName || spot.airline) : ""}${spot.route ? ` · ${esc(spot.route)}` : ""}</div>` +
      `<small>${esc([spot.reg, spot.desc].filter(Boolean).join(" · "))}</small>` +
      `<small>${spot.altFt.toLocaleString()} ft · ${spot.distM.toLocaleString()} m away · ${new Date(spot.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${esc(spot.city)}</small>`;
    this.card.style.display = "";
    this.cardTimer = 6;
    this.paintButton();
    if (this.log.style.display !== "none") {
      this.toggleLog();
      this.toggleLog();
    }
    // Spotted: let the next frame pick the nearest one still to find.
    if (this.layer.tags.selectedHex === i.hex) this.layer.tags.select(null);
    this.target = null;
  }

  private drawRadar(tracks: Track[], me: { x: number; y: number; z: number; headingDeg: number }, tgt: Track | null): void {
    const g = this.g;
    const c = RADAR_PX / 2;
    const R = c - 6;
    const dists = tracks
      .filter((t) => !t.info.cat.startsWith("C"))
      .map((t) => Math.hypot(t.pose.x - me.x, t.pose.z - me.z))
      .sort((a, b) => a - b);
    const fit = dists[Math.min(RADAR_FIT, dists.length) - 1] ?? 0;
    const RADAR_M = RADAR_STEPS.find((r) => r >= fit * 1.1) ?? RADAR_STEPS[RADAR_STEPS.length - 1];
    const k = R / RADAR_M;
    const rot = (-me.headingDeg * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    g.clearRect(0, 0, RADAR_PX, RADAR_PX);
    g.fillStyle = "rgba(6, 14, 12, 0.72)";
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(120, 230, 170, 0.22)";
    g.lineWidth = 1.5;
    for (const f of [0.25, 0.5, 1]) {
      g.beginPath();
      g.arc(c, c, R * f, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = "rgba(120, 230, 170, 0.5)";
    g.font = "500 15px ui-monospace, monospace";
    g.textAlign = "left";
    const km = (m: number) => `${m / 1000}`;
    g.fillText(km(RADAR_M / 4), c + 3, c - R * 0.25 + 14);
    g.fillText(km(RADAR_M / 2), c + 3, c - R * 0.5 + 14);
    g.fillText(`${km(RADAR_M)} km`, c - 20, c - R + 22);
    // North tick on the rim, where north is out of the window.
    const na = (-me.headingDeg * Math.PI) / 180;
    g.fillStyle = "rgba(255, 122, 102, 0.95)";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("N", c + Math.sin(na) * (R - 14), c - Math.cos(na) * (R - 14));

    // Trains and boats first, so an aircraft blip is never under one.
    for (const t of this.transit) {
      const dx = t.x - me.x;
      const dz = t.z - me.z;
      if (dx * dx + dz * dz > RADAR_M * RADAR_M) continue;
      const px = c + (dx * cos - dz * sin) * k;
      const py = c + (dx * sin + dz * cos) * k;
      g.fillStyle = t.color;
      g.globalAlpha = t.under ? 0.45 : 0.9;
      g.fillRect(px - 2.5, py - 2.5, 5, 5);
    }
    g.globalAlpha = 1;

    this.blips.length = 0;
    const near = tracks
      .map((t) => ({ t, d: Math.hypot(t.pose.x - me.x, t.pose.z - me.z) }))
      .filter((b) => b.d < RADAR_M && !b.t.info.cat.startsWith("C"))
      .sort((a, b) => a.d - b.d);
    this.near.length = 0;
    for (const { t, d } of near) {
      if (d > 1500) break;
      this.near.push({ x: t.pose.x, z: t.pose.z, headingDeg: t.pose.headingDeg, target: t === tgt });
    }
    const labelled: { x: number; y: number }[] = [];
    near.forEach(({ t }, idx) => {
      const dx = t.pose.x - me.x;
      const dz = t.pose.z - me.z;
      const px = c + (dx * cos - dz * sin) * k;
      const py = c + (dx * sin + dz * cos) * k;
      this.blips.push({ hex: t.info.hex, px, py });
      const dy = t.pose.y - me.y;
      const spotted = this.book.has(t.info.hex);
      // Above you cyan, below you amber, level white: which way to climb.
      const col = spotted ? "rgba(150,160,170,0.6)" : dy > 150 ? "#66d4ff" : dy < -150 ? "#ffb347" : "#f2f6fa";
      // Heading tick: the way it is going, in the radar's rotated frame.
      const h = ((t.pose.headingDeg - me.headingDeg) * Math.PI) / 180;
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.sin(h) * 11, py - Math.cos(h) * 11);
      g.stroke();
      g.fillStyle = col;
      g.beginPath();
      g.arc(px, py, t.k.ground ? 2.5 : 4, 0, Math.PI * 2);
      if (spotted) g.stroke();
      else g.fill();
      if (tgt && t === tgt) {
        g.strokeStyle = "#ffd166";
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(px, py, 10, 0, Math.PI * 2);
        g.stroke();
      }
      // Labels on the nearest few, skipping any that would print over one
      // already written.
      const clear = !labelled.some((l) => Math.abs(l.x - px) < 70 && Math.abs(l.y - py) < 16);
      if ((idx < RADAR_LABELS && clear) || t === tgt) {
        labelled.push({ x: px, y: py });
        g.fillStyle = "rgba(242,246,250,0.85)";
        g.font = "500 14px ui-monospace, monospace";
        g.textAlign = "left";
        g.fillText(t.info.flight || t.info.reg || t.info.type, px + 8, py - 9);
      }
    });
    // You, at the centre, pointing up.
    g.fillStyle = "#fff";
    g.beginPath();
    g.moveTo(c, c - 9);
    g.lineTo(c + 6, c + 7);
    g.lineTo(c, c + 3);
    g.lineTo(c - 6, c + 7);
    g.closePath();
    g.fill();
  }
}
