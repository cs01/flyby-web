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

const KTS_PER_MS = 1.94384;

function el(cls: string, html: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function compass(deg: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export class Hud {
  private root: HTMLElement;
  private wxPanel: HTMLDivElement;
  private flightPanel: HTMLDivElement;
  private placePanel: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.placePanel = el("hud hud-tl", "");
    this.wxPanel = el("hud hud-tr", "");
    this.flightPanel = el("hud hud-bl", "");
    root.append(this.placePanel, this.wxPanel, this.flightPanel);

    const att = document.createElement("div");
    att.className = "attrib";
    att.textContent =
      "Terrain: NASA SRTM via AWS Terrain Tiles · Imagery: Esri World Imagery · Buildings: © OpenStreetMap contributors (ODbL) · Weather: Open-Meteo";
    root.append(att);
  }

  setPlace(city: City, localTime: string): void {
    this.placePanel.innerHTML = `
      <h2>${city.name}</h2>
      <div class="row"><span>${city.country}</span><b>${localTime}</b></div>`;
  }

  setWeather(wx: Weather): void {
    const age = Math.round((Date.now() - wx.time.getTime()) / 60000);
    const badge = wx.live
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
      <div class="row"><span>Wind</span><b>${compass(wx.windDir)} ${Math.round(wx.windSpeed * KTS_PER_MS)} kt</b></div>
      <div class="row"><span>Visibility</span><b>${(wx.visibility / 1000).toFixed(1)} km</b></div>
      <div class="row"><span>QNH</span><b>${Math.round(wx.pressureHpa)} hPa</b></div>
      ${decks.map((d) => `<div class="row"><span>${d}</span></div>`).join("")}
      ${badge}`;
  }

  setFlight(altM: number, speedMs: number, headingDeg: number, agl: number): void {
    this.flightPanel.innerHTML = `
      <div class="row"><span>ALT</span><b>${Math.round(altM * 3.28084).toLocaleString()} ft</b></div>
      <div class="row"><span>AGL</span><b>${Math.round(agl * 3.28084).toLocaleString()} ft</b></div>
      <div class="row"><span>SPD</span><b>${Math.round(speedMs * KTS_PER_MS)} kt</b></div>
      <div class="row"><span>HDG</span><b>${String(Math.round(headingDeg)).padStart(3, "0")}°</b></div>`;
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
