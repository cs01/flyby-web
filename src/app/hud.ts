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
import { formatTemp } from "./units";
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

  constructor(root: HTMLElement) {
    this.root = root;
    this.placePanel = el("hud hud-tl", "");
    this.wxPanel = el("hud hud-tr", "");
    // Empty and display:none until setPerf is called, which only happens with
    // ?fps. An empty panel still painted its own backdrop otherwise.
    this.perfPanel = el("hud hud-perf", "");
    this.perfPanel.style.display = "none";
    root.append(this.placePanel, this.wxPanel, this.perfPanel);

    // On a phone these two are collapsed to their headings and expand on a tap.
    // At full height they cover a third of the sky each, and the sky is what
    // the app is; the CSS does the collapsing, this only makes them tappable.
    // The class is set unconditionally so a desktop window narrowed to a phone
    // width behaves the same way, rather than depending on what the window was
    // when the page loaded.
    this.wxPanel.classList.add("collapsible");
    this.wxPanel.addEventListener("click", () => this.wxPanel.classList.toggle("open"));

    // An anchor so ctrl/cmd-click opens the picker in a new tab, like any link.
    const back = document.createElement("a");
    back.className = "back";
    back.textContent = "\u2190 cities";
    const backParams = new URLSearchParams(location.search);
    // BOTH of the ways a place can be named. Dropping only `city` meant that
    // from a searched or geolocated flight -- which is named by `at` -- the
    // link resolved to the URL you were already on, so the button reloaded the
    // same place instead of going back.
    backParams.delete("city");
    backParams.delete("at");
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
    // The age is only worth the reader's attention once it is a PROBLEM. An
    // observation is published hourly, so anything under an hour is simply
    // the current weather and saying "11 min old" invites a worry that does
    // not exist. Past that it has stopped being current and the badge says so.
    // The exact stamp is on the hover either way, for anyone who wants it.
    const stamp = wx.time.toLocaleString();
    const badge =
      wx.source === "forecast"
        ? `<span class="tag tag-fc" title="Forecast for ${stamp}">Forecast · ${offsetLabel(offsetSeconds)}</span>`
        : wx.source === "observation"
          ? age > 60
            ? `<span class="tag tag-stale" title="Observed ${stamp}">${Math.round(age / 60)} h old</span>`
            : `<span class="tag tag-live" title="Observed ${stamp}">Live</span>`
          : `<span class="tag tag-stale" title="No feed reached">Simulated</span>`;
    // The lowest deck that is actually there, in feet, because that is the
    // number that says whether you are about to fly into it.
    const deck =
      wx.low.cover > 0.05
        ? `${Math.round(wx.low.cover * 100)}% at ${Math.round((wx.low.base * 3.28084) / 100) * 100} ft`
        : wx.mid.cover > 0.05
          ? `${Math.round(wx.mid.cover * 100)}% mid`
          : wx.high.cover > 0.05
            ? `${Math.round(wx.high.cover * 100)}% high`
            : "clear";

    // Temperature first and large. Dewpoint, visibility and QNH were four more
    // rows of numbers that nobody flying a sightseeing aeroplane reads, and
    // they cost the panel the one thing it is actually asked -- how warm is it
    // and what is the sky doing.
    this.wxPanel.innerHTML = `
      <h2>${wx.summary}</h2>
      <div class="wx-temp">${formatTemp(wx.tempC)}</div>
      <div class="row"><span>Wind</span><b>${compassPoint(wx.windDir)} ${Math.round(wx.windSpeed * KTS_PER_MS)} kt</b></div>
      <div class="row"><span>Cloud</span><b>${deck}</b></div>
      ${badge}`;
  }

  /**
   * Frame time, shown as both fps and milliseconds. Milliseconds because that
   * is the number that composes: "the cloud march costs 4 ms" is actionable,
   * "fps dropped from 60 to 48" is not.
   */
  setPerf(fps: number, ms: number, triangles: number, scale: number, banding: number): void {
    const q = scale < 0.999 ? `<div class="row"><span>scale</span><b>${scale.toFixed(2)}x</b></div>` : "";
    this.perfPanel.style.display = "";
    this.perfPanel.innerHTML = `
      <div class="row"><span>${fps.toFixed(0)} fps</span><b>${ms.toFixed(1)} ms</b></div>
      <div class="row"><span>tris</span><b>${(triangles / 1000).toFixed(0)}k</b></div>
      <div class="row"><span>band</span><b>${banding.toFixed(2)}</b></div>${q}`;
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

  private controlsCard: HTMLElement | null = null;

  /** Toggled by H. Nothing shows it on arrival any more. */
  toggleControls(): void {
    if (this.controlsCard) {
      this.controlsCard.remove();
      this.controlsCard = null;
      return;
    }
    this.showControls();
  }

  /** Which of the optional panels are drawn. Set from the layers checkboxes. */
  setLayers(weather: boolean): void {
    this.wxPanel.style.display = weather ? "" : "none";
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
      <div class="row"><span>Climb / dive</span><b>&#8595; / &#8593;</b></div>
      <div class="row"><span>Turn</span><b>Q / E · drag</b></div>
      <div class="row"><span>Turbo</span><b>Space · Shift</b></div>
      <div class="row"><span>Camera</span><b>C · look back B</b></div>
      <div class="row"><span>Drone</span><b>V · mouse looks</b></div>
      <div class="row"><span>Time</span><b>, . · 0 · T</b></div>`;
    const d = el("hud hud-controls", rows + `
      <div class="row"><span>Hide</span><b>H</b></div>`);
    this.root.append(d);
    this.controlsCard = d;
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
