// The overlay. DOM, not canvas: text rendered by the browser is crisper at any
// DPI than anything drawn into WebGL, it reflows on a phone for free, and it
// costs zero draw calls.
//
// The weather panel names its SOURCE and its AGE. A sky that is quietly
// synthetic while implying it is live is the failure mode worth engineering
// against, so when the feed is unavailable the badge says so rather than the
// panel silently showing plausible numbers.

import type { Weather } from "../data/weather";
import type { City } from "../cities";
import { compassPoint } from "./osd";
import { offsetLabel } from "./timebar";
import { isTouchDevice } from "../sim/touch";

const KTS_PER_MS = 1.94384;

function el(cls: string, html: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  return d;
}

export class Hud {
  private root: HTMLElement;
  private wxPanel: HTMLDivElement;
  private placePanel: HTMLDivElement;
  private perfPanel: HTMLDivElement;
  private tourPanel: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.placePanel = el("hud hud-tl", "");
    this.wxPanel = el("hud hud-tr", "");
    this.perfPanel = el("hud hud-perf", "");
    this.tourPanel = el("hud hud-br", "");
    root.append(this.placePanel, this.wxPanel, this.perfPanel, this.tourPanel);

    // On a phone these two are collapsed to their headings and expand on a tap.
    // At full height they cover a third of the sky each, and the sky is what
    // the app is; the CSS does the collapsing, this only makes them tappable.
    // The class is set unconditionally so a desktop window narrowed to a phone
    // width behaves the same way, rather than depending on what the window was
    // when the page loaded.
    for (const panel of [this.wxPanel, this.tourPanel]) {
      panel.classList.add("collapsible");
      panel.addEventListener("click", () => panel.classList.toggle("open"));
    }

    // An anchor so ctrl/cmd-click opens the picker in a new tab, like any link.
    const back = document.createElement("a");
    back.className = "back";
    back.textContent = "\u2190 cities";
    const backParams = new URLSearchParams(location.search);
    backParams.delete("city");
    const q = backParams.toString();
    back.href = q ? `?${q}` : location.pathname;
    root.append(back);

    // Two attributions, one shown at a time by the stylesheet. Every source is
    // still named in the short one -- what goes is the plumbing (which tile
    // service, which licence), not the credit. Spelled out in full it wraps to
    // three lines on a phone and the last of them falls off the bottom of the
    // screen, which credits nobody.
    const att = document.createElement("div");
    att.className = "attrib";
    att.innerHTML =
      `<span class="attrib-full">Terrain: NASA SRTM via AWS Terrain Tiles · Imagery: Esri World Imagery ·` +
      ` Buildings: © OpenStreetMap contributors (ODbL) · Weather: Open-Meteo</span>` +
      `<span class="attrib-short">SRTM · Esri · © OpenStreetMap · Open-Meteo</span>`;
    root.append(att);
  }

  /**
   * The city's own wall clock, not the viewer's and not UTC.
   *
   * UTC was the only clock here and it is the wrong one to lead with: nobody
   * flying over Manhattan wants to work out what 06:33Z means locally, and the
   * whole point of the sun being computed properly is that the time of day is
   * something you can SEE. The local time is what agrees with the picture.
   */
  setPlace(city: City, localTime: string, zone: string): void {
    this.placePanel.innerHTML = `
      <h2>${city.name}</h2>
      <div class="row"><span>${city.country}</span><b>${localTime} <i>${zone}</i></b></div>`;
  }

  /**
   * `offsetSeconds` is how far the scene clock has been moved off the present.
   *
   * The badge has to carry it. A forecast for tomorrow morning came off the
   * wire exactly as much as the current observation did, so "live" cannot be
   * the distinction -- and a panel that said LIVE over a prediction would be
   * the one dishonesty this app is built to avoid.
   */
  setWeather(wx: Weather, offsetSeconds = 0): void {
    const age = Math.round((Date.now() - wx.time.getTime()) / 60000);
    const badge =
      wx.source === "forecast"
        ? `<span class="tag tag-fc">Forecast · ${offsetLabel(offsetSeconds)}</span>`
        : wx.source === "observation"
          ? `<span class="tag tag-live">Live · ${age} min old</span>`
          : `<span class="tag tag-stale">No feed · simulated</span>`;
    const decks = [
      wx.low.cover > 0.05 ? `LOW ${Math.round(wx.low.cover * 100)}% @ ${Math.round(wx.low.base)} m` : null,
      wx.mid.cover > 0.05 ? `MID ${Math.round(wx.mid.cover * 100)}%` : null,
      wx.high.cover > 0.05 ? `HIGH ${Math.round(wx.high.cover * 100)}%` : null,
    ].filter(Boolean);

    this.wxPanel.innerHTML = `
      <h2>${wx.summary}</h2>
      <div class="row"><span>Temp</span><b>${wx.tempC.toFixed(1)} °C</b></div>
      <div class="row"><span>Dewpoint</span><b>${wx.dewC.toFixed(1)} °C</b></div>
      <div class="row"><span>Wind</span><b>${compassPoint(wx.windDir)} ${Math.round(wx.windSpeed * KTS_PER_MS)} kt</b></div>
      <div class="row"><span>Visibility</span><b>${(wx.visibility / 1000).toFixed(1)} km</b></div>
      <div class="row"><span>QNH</span><b>${Math.round(wx.pressureHpa)} hPa</b></div>
      ${decks.map((d) => `<div class="row"><span>${d}</span></div>`).join("")}
      ${badge}`;
  }

  /**
   * Frame time, shown as both fps and milliseconds. Milliseconds because that
   * is the number that composes: "the cloud march costs 4 ms" is actionable,
   * "fps dropped from 60 to 48" is not.
   */
  setPerf(fps: number, ms: number, triangles: number, scale: number): void {
    const q = scale < 0.999 ? `<div class="row"><span>scale</span><b>${scale.toFixed(2)}x</b></div>` : "";
    this.perfPanel.innerHTML = `
      <div class="row"><span>${fps.toFixed(0)} fps</span><b>${ms.toFixed(1)} ms</b></div>
      <div class="row"><span>tris</span><b>${(triangles / 1000).toFixed(0)}k</b></div>${q}`;
  }

  /**
   * Route checklist. Shows what has been reached and what is next, with the
   * per-leg time -- the leg time is what turns a checklist into a score.
   */
  setTour(marks: { name: string; collected: boolean; legSeconds: number }[], distanceM: number, finished: boolean): void {
    const rows = marks.map((m, i) => {
      const next = !m.collected && marks.slice(0, i).every((x) => x.collected);
      const mark = m.collected ? "✓" : next ? "▸" : "·";
      const time = m.collected
        ? `${Math.floor(m.legSeconds / 60)}:${String(Math.floor(m.legSeconds % 60)).padStart(2, "0")}`
        : next ? `${(distanceM / 1000).toFixed(1)} km` : "";
      const cls = m.collected ? "done" : next ? "next" : "";
      return `<div class="row ${cls}"><span>${mark} ${m.name}</span><b>${time}</b></div>`;
    });
    this.tourPanel.innerHTML =
      `<h2>${finished ? "Route complete" : "Route"}</h2>${rows.join("")}`;
  }

  /** Transient toast, used for the pitch-axis toggle. */
  toast(text: string): void {
    const d = el("landmark-flash", `<span>${text}</span>`);
    this.root.append(d);
    requestAnimationFrame(() => d.classList.add("in"));
    setTimeout(() => {
      d.classList.remove("in");
      setTimeout(() => d.remove(), 800);
    }, 1400);
  }

  /** Brief confirmation when a landmark is reached. */
  flashLandmark(name: string): void {
    const d = el("landmark-flash", `<span>${name}</span>`);
    this.root.append(d);
    requestAnimationFrame(() => d.classList.add("in"));
    setTimeout(() => {
      d.classList.remove("in");
      setTimeout(() => d.remove(), 800);
    }, 2200);
  }

  showControls(): void {
    // A phone has no keys to name, and naming them is worse than saying
    // nothing: the one thing someone on a touch screen needs told is that the
    // two halves of the screen do different jobs, which is not discoverable.
    const rows = isTouchDevice()
      ? `
      <div class="row"><span>Left half</span><b>roll · up climbs</b></div>
      <div class="row"><span>Right half</span><b>throttle · rudder</b></div>
      <div class="row"><span>Buttons</span><b>cam · boost · look</b></div>
      <div class="row"><span>Time</span><b>the bar up top</b></div>`
      : `
      <div class="row"><span>Move</span><b>W A S D</b></div>
      <div class="row"><span>Up / down</span><b>Space / Ctrl</b></div>
      <div class="row"><span>Turn</span><b>Q / E · drag</b></div>
      <div class="row"><span>Boost</span><b>Shift</b></div>
      <div class="row"><span>Camera</span><b>C · look back B</b></div>
      <div class="row"><span>Time</span><b>, . · 0 · T</b></div>`;
    const d = el("hud hud-controls", rows);
    this.root.append(d);
    // Fade out once the flying has started; it is a reminder, not a panel.
    setTimeout(() => {
      d.style.transition = "opacity 1.4s ease";
      d.style.opacity = "0";
      setTimeout(() => d.remove(), 1600);
    }, 9000);
  }

  remove(): void {
    this.root.innerHTML = "";
  }
}

export class LoadingScreen {
  private root: HTMLDivElement;
  private bar: HTMLElement;
  private step: HTMLElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "loading";
    this.root.innerHTML = `
      <div class="title">FLYBY</div>
      <div class="bar"><i></i></div>
      <div class="step">starting</div>`;
    document.body.append(this.root);
    this.bar = this.root.querySelector(".bar i")!;
    this.step = this.root.querySelector(".step")!;
  }

  set(fraction: number, text: string): void {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    this.step.textContent = text;
  }

  done(): void {
    this.root.classList.add("done");
    setTimeout(() => this.root.remove(), 900);
  }
}
