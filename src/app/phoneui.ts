// The phone layout: one slim bar on top, one sheet for everything secondary,
// and at the bottom only what the current machine needs.
//
// The panels themselves are the desktop's (places, layers, weather, the time
// scrubber, the credits). On a phone they are MOVED into two bottom sheets
// rather than rebuilt, so there is one implementation of each and the phone
// cannot drift from the desktop. Everything else is positioned by style.css
// under `#ui.phone`, keyed on `data-mode`, so "what shows when" is one table
// of selectors rather than display toggles spread across main.ts.

import { auditBoxes, type Box } from "./layoutaudit";
import type { Machine } from "./modebar";

/** Controls that must never overlap each other on a phone. Labels are
 *  checked against these but not against each other (labels.ts already
 *  keeps those apart). */
const CONTROLS = [
  ".topbar", ".modebar", ".mission-btn", ".mission-card", ".touch-btn", ".throttle",
  ".minimap", ".osd", ".ride-hint", ".spot-btn", ".spot-radar", ".street-sign",
  ".touch-home.move", ".intro-skip", ".landmark-flash", ".escape-card",
];

export class PhoneShell {
  private readonly city: HTMLElement;
  private readonly time: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private readonly menuBody: HTMLElement;
  private readonly timeSheet: HTMLElement;
  private readonly scrim: HTMLElement;
  private mode = "";

  constructor(private readonly ui: HTMLElement, cityName: string) {
    ui.classList.add("phone");
    // The phone has no clean-view switch any more: the layout is the clean
    // view, and the instruments and map are switches in the menu.
    ui.classList.remove("clean");

    const bar = document.createElement("div");
    bar.className = "topbar";
    this.city = document.createElement("span");
    this.city.className = "topbar-city";
    this.city.textContent = cityName;
    this.time = document.createElement("button");
    this.time.className = "topbar-time";
    this.time.setAttribute("aria-label", "Time of day");
    this.time.textContent = "--:--";
    const menuBtn = document.createElement("button");
    menuBtn.className = "topbar-menu";
    menuBtn.setAttribute("aria-label", "Menu");
    menuBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;
    bar.append(this.city, this.time, menuBtn);

    this.scrim = document.createElement("div");
    this.scrim.className = "sheet-scrim";
    this.scrim.addEventListener("click", () => this.close());

    this.menu = this.sheet("sheet-menu", "Menu");
    this.menuBody = this.menu.querySelector(".sheet-body") as HTMLElement;
    this.timeSheet = this.sheet("sheet-time", "Time of day");

    ui.append(bar, this.scrim, this.menu, this.timeSheet);
    menuBtn.addEventListener("click", () => this.toggle(this.menu));
    this.time.addEventListener("click", () => this.toggle(this.timeSheet));
  }

  private sheet(cls: string, title: string): HTMLElement {
    const s = document.createElement("div");
    s.className = `sheet ${cls}`;
    s.setAttribute("role", "dialog");
    s.setAttribute("aria-label", title);
    s.innerHTML =
      `<div class="sheet-head"><b>${title}</b><button class="sheet-close" aria-label="Close">×</button></div>` +
      `<div class="sheet-body"></div>`;
    (s.querySelector(".sheet-close") as HTMLElement).addEventListener("click", () => this.close());
    return s;
  }

  private toggle(s: HTMLElement): void {
    const open = !s.classList.contains("open");
    this.close();
    if (open) {
      s.classList.add("open");
      this.scrim.classList.add("open");
    }
  }

  close(): void {
    this.menu.classList.remove("open");
    this.timeSheet.classList.remove("open");
    this.scrim.classList.remove("open");
  }

  get open(): boolean {
    return this.scrim.classList.contains("open");
  }

  /**
   * Move the desktop's panels into the sheets. Called once, after every
   * panel exists. Missing ones are skipped: a city with no places list
   * still gets a menu.
   */
  adopt(): void {
    const q = (sel: string) => this.ui.querySelector<HTMLElement>(`:scope > ${sel}`);
    const body = this.menuBody;
    // Short things first; the places list is forty rows and goes last.
    const back = q(".back");
    if (back) body.append(back);
    for (const sel of [".hud-eruption", ".hud-layers", ".hud-tr", ".hud-places"]) {
      const el = q(sel);
      if (!el) continue;
      // The phone sheet shows them open: a collapsed heading inside a sheet
      // is a second tap for nothing.
      el.classList.remove("collapsible");
      el.classList.add("open");
      body.append(el);
    }
    const att = q(".attrib");
    if (att) body.append(att);
    const tb = q(".timebar");
    if (tb) (this.timeSheet.querySelector(".sheet-body") as HTMLElement).append(tb);
    q(".hud-toggle")?.remove();
  }

  setTime(text: string): void {
    if (this.time.textContent !== text) this.time.textContent = text;
  }

  setCity(name: string): void {
    if (this.city.textContent !== name) this.city.textContent = name;
  }

  /** What the bottom of the screen is for right now. Cheap when unchanged. */
  setMode(m: Machine | "ride"): void {
    if (m === this.mode) return;
    this.mode = m;
    this.ui.dataset.mode = m;
  }

  /** The screen band between the bar and the highest control in the lower
   *  half, CSS px; place labels stay inside it. */
  labelBand(): { top: number; bottom: number } {
    const bar = this.ui.querySelector(".topbar")?.getBoundingClientRect();
    let bottom = innerHeight;
    for (const sel of CONTROLS) {
      for (const el of this.ui.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.top < innerHeight / 2) continue;
        bottom = Math.min(bottom, r.top - 4);
      }
    }
    return { top: (bar?.bottom ?? 0) + 4, bottom };
  }

  /** Every pair of visible controls that overlap, plus any off the screen. */
  overlaps(): string[] {
    const boxes: Box[] = [];
    const seen = new Set<Element>();
    const visible = (el: Element): DOMRect | null => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      for (let e: Element | null = el; e && e !== this.ui; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return null;
      }
      return r;
    };
    for (const sel of CONTROLS) {
      for (const el of this.ui.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const r = visible(el);
        if (r) boxes.push({ name: sel + (el.textContent ? `(${el.textContent.trim().slice(0, 12)})` : ""), x: r.x, y: r.y, w: r.width, h: r.height });
      }
    }
    const out = auditBoxes(boxes, innerWidth, innerHeight);
    // Labels against the controls only.
    for (const el of this.ui.querySelectorAll(".label")) {
      const r = visible(el);
      if (!r) continue;
      const lab = { name: `.label(${(el.textContent ?? "").slice(0, 12)})`, x: r.x, y: r.y, w: r.width, h: r.height };
      for (const b of boxes) {
        for (const hit of auditBoxes([lab, b], Infinity, Infinity)) out.push(hit);
      }
    }
    return out;
  }
}
