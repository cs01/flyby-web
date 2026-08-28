// The clock, and the ability to move it.
//
// Two things share one control here, because they are one question. "What will
// it look like at eight tomorrow morning" is half a SUN question and half a
// WEATHER question, and answering only one of them is worse than answering
// neither: a dawn sky under this afternoon's cloud is a picture of a moment
// that will never exist.
//
// So the scrubber moves the scene clock, and the scene clock drives both --
// the solar position (computed locally, exact, and free) and the weather
// (Open-Meteo's hourly forecast, interpolated). When the forecast is
// unreachable the clock still moves and the strip says the weather is being
// carried rather than predicted, which is the honest version of a degraded
// mode.
//
// The FORECAST BAND under the slider is the part that makes this usable. A
// slider alone means scrubbing blind, hunting for the interesting hour; the
// band paints every hour ahead as the colour of its sky, so a clear dawn or a
// front coming through is something you can see and click on rather than
// something you have to find.

import { solarState } from "../data/solar";
import type { WeatherTimeline } from "../data/weather";

/** How far the scrubber reaches, in hours either side of the present. */
export const SCRUB_BACK_H = 12;
export const SCRUB_FWD_H = 120;

/** Hours drawn in the forecast band. */
const BAND_HOURS = 60;

/**
 * The city's wall clock, formatted by `Intl` in the city's own IANA zone.
 *
 * Not by adding a fixed offset to a UTC instant. The scrubber reaches five days
 * ahead, which can cross a daylight-saving change, and a fixed offset is then
 * an hour wrong for part of its own range -- the one place where being an hour
 * out is most visible, because the sun in the picture would not agree with the
 * clock beside it.
 */
export class LocalClock {
  private fmt: Intl.DateTimeFormat;
  private zoneFmt: Intl.DateTimeFormat;

  constructor(readonly timezone: string) {
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    // An invalid zone throws rather than falling back, and a bad zone string
    // off the wire must not take the whole HUD down with it.
    try {
      this.fmt = new Intl.DateTimeFormat("en-GB", opts);
    } catch {
      this.fmt = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: "UTC" });
    }
    try {
      this.zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" });
    } catch {
      this.zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", timeZoneName: "short" });
    }
  }

  parts(when: Date): { hhmm: string; day: string; hour: number } {
    const p = this.fmt.formatToParts(when);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    // Some locales render midnight as 24; the band's day-boundary test depends
    // on hour 0 existing, so it is normalised here rather than at every use.
    const h = Number(get("hour")) % 24;
    const m = Number(get("minute"));
    return {
      hhmm: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      day: get("weekday"),
      hour: h + m / 60,
    };
  }

  /** "EDT", "CEST", "GMT+8". Whatever the zone is actually called. */
  abbrev(when: Date): string {
    return this.zoneFmt.formatToParts(when).find((x) => x.type === "timeZoneName")?.value ?? "UTC";
  }
}

/** "+3h 30m", "-45m", or "now". */
export function offsetLabel(seconds: number): string {
  const s = Math.round(seconds / 60) * 60;
  if (Math.abs(s) < 60) return "now";
  const sign = s < 0 ? "-" : "+";
  const a = Math.abs(s);
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  return sign + parts.join(" ");
}

/**
 * The colour an hour's sky will be: daylight from the sun's altitude, tinted
 * grey by how much cloud is in the way. This is a caricature of the renderer's
 * own atmosphere, not a preview of it -- but it agrees with it about the two
 * things a glance needs, which is whether it is light and whether it is grey.
 */
function skyColour(daylight: number, cover: number, sunAlt: number): string {
  // Twilight: the band between civil dusk and a few degrees up is where the
  // colour is, so it gets its own ramp rather than being a fade to black.
  const golden = Math.max(0, 1 - Math.abs(sunAlt - 3) / 9);
  const r = 12 + daylight * 96 + golden * 130;
  const g = 18 + daylight * 132 + golden * 60;
  const b = 34 + daylight * 190 + golden * 6;
  const grey = 0.62 * cover;
  const mix = (c: number) => Math.round(c * (1 - grey) + (150 * daylight + 30) * grey);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

export interface TimebarOptions {
  lat: number;
  lon: number;
  /** UTC instant the session started from; the scrubber is relative to it. */
  base: Date;
  /** IANA zone for the city. */
  timezone: string;
  timeline: WeatherTimeline | null;
  onOffset: (seconds: number) => void;
  onTimelapse: (on: boolean) => void;
}

export class Timebar {
  private root: HTMLDivElement;
  private clock: HTMLElement;
  private zone: HTMLElement;
  private offsetChip: HTMLElement;
  private sunChip: HTMLElement;
  private slider: HTMLInputElement;
  private lapseBtn: HTMLButtonElement;
  private cursor: HTMLElement;
  private opts: TimebarOptions;
  private clockFmt: LocalClock;

  private offset = 0;

  constructor(parent: HTMLElement, opts: TimebarOptions) {
    this.opts = opts;
    this.clockFmt = new LocalClock(opts.timezone);
    this.root = document.createElement("div");
    this.root.className = "timebar";
    this.root.innerHTML = `
      <div class="tb-top">
        <button class="tb-btn" data-step="-3600" title="Back one hour">&#9664;</button>
        <div class="tb-clock">
          <b>--:--</b>
          <span class="tb-zone"></span>
        </div>
        <button class="tb-btn" data-step="3600" title="Forward one hour">&#9654;</button>
        <span class="tb-offset">now</span>
        <span class="tb-sun"></span>
        <button class="tb-btn tb-now" title="Back to the present">NOW</button>
        <button class="tb-btn tb-lapse" title="Run the clock fast (T)">&#9193;</button>
      </div>
      <div class="tb-band"><div class="tb-cursor"></div></div>
      <input class="tb-slider" type="range" step="300"
             min="${-SCRUB_BACK_H * 3600}" max="${SCRUB_FWD_H * 3600}" value="0" />`;
    parent.append(this.root);

    this.clock = this.root.querySelector(".tb-clock b")!;
    this.zone = this.root.querySelector(".tb-zone")!;
    this.offsetChip = this.root.querySelector(".tb-offset")!;
    this.sunChip = this.root.querySelector(".tb-sun")!;
    this.slider = this.root.querySelector(".tb-slider")!;
    this.lapseBtn = this.root.querySelector(".tb-lapse")!;
    this.cursor = this.root.querySelector(".tb-cursor")!;

    this.zone.textContent = this.clockFmt.abbrev(opts.base);

    for (const b of this.root.querySelectorAll<HTMLButtonElement>("[data-step]")) {
      b.addEventListener("click", () => this.nudge(Number(b.dataset.step)));
    }
    this.root.querySelector(".tb-now")!.addEventListener("click", () => this.setOffset(0));
    this.lapseBtn.addEventListener("click", () => {
      const on = !this.lapseBtn.classList.contains("on");
      this.setTimelapse(on);
      opts.onTimelapse(on);
    });
    this.slider.addEventListener("input", () => this.setOffset(Number(this.slider.value)));

    this.buildBand();
  }

  /**
   * One cell per hour, coloured by that hour's sky. Clicking one moves the
   * clock to it, which is the fastest way to reach "tomorrow at sunrise".
   */
  private buildBand(): void {
    const band = this.root.querySelector(".tb-band")!;
    const { lat, lon, base, timeline } = this.opts;
    for (let h = 0; h < BAND_HOURS; h++) {
      const t = new Date(base.getTime() + h * 3600_000);
      const solar = solarState(t, lat, lon);
      const wx = timeline?.at(t);
      const cell = document.createElement("i");
      cell.style.background = skyColour(solar.daylight, wx ? wx.totalCover : 0, solar.sun.altitude);
      const local = this.clockFmt.parts(t);
      cell.title = `${local.day} ${local.hhmm} · ${wx ? wx.summary : "no forecast"}`;
      // Midnight gets a rule, so a day is a countable unit on the band rather
      // than an undifferentiated smear of colour.
      if (local.hour < 1) cell.classList.add("day-start");
      cell.addEventListener("click", () => this.setOffset(h * 3600));
      band.append(cell);
    }
  }

  private nudge(seconds: number): void {
    this.setOffset(this.offset + seconds);
  }

  /** Clamped to the scrubber's range, then pushed out to the scene. */
  setOffset(seconds: number): void {
    const lo = -SCRUB_BACK_H * 3600;
    const hi = SCRUB_FWD_H * 3600;
    this.offset = Math.max(lo, Math.min(hi, seconds));
    if (Number(this.slider.value) !== this.offset) this.slider.value = String(this.offset);
    this.opts.onOffset(this.offset);
  }

  get offsetSeconds(): number {
    return this.offset;
  }

  setTimelapse(on: boolean): void {
    this.lapseBtn.classList.toggle("on", on);
  }

  /** Called every few frames with the clock the scene is actually rendering. */
  update(now: Date, sunAltitude: number): void {
    const p = this.clockFmt.parts(now);
    const label = `${p.day} ${p.hhmm}`;
    if (this.clock.textContent !== label) this.clock.textContent = label;

    const off = offsetLabel(this.offset);
    if (this.offsetChip.textContent !== off) this.offsetChip.textContent = off;
    this.offsetChip.classList.toggle("shifted", Math.abs(this.offset) >= 60);

    const sun =
      sunAltitude > 0
        ? `☀ ${sunAltitude.toFixed(0)}°`
        : sunAltitude > -6
          ? "◑ twilight"
          : "☾ night";
    if (this.sunChip.textContent !== sun) this.sunChip.textContent = sun;

    // The band starts at the session's base time, so the cursor is the offset
    // as a fraction of the band's span -- negative offsets run off its left
    // end, which is correct: there is no past on a forecast band.
    const frac = this.offset / 3600 / BAND_HOURS;
    this.cursor.style.left = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    this.cursor.style.opacity = frac < 0 || frac > 1 ? "0.25" : "1";
  }
}
