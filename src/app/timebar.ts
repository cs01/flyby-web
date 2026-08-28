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
// ONE CONTROL, and it is the picture of the forecast itself. This used to be a
// row of buttons, a range slider, and a coloured band under the slider that
// meant something different again: three controls for one number, in three
// colour languages, and the only one that told you anything was the band. So
// the band IS the scrubber now -- each cell painted the colour that hour's sky
// will be, and you drag along it. Every button it had is a keyboard binding
// that still works (`,` `.` step, `0` back to now, `T` timelapse); none of
// them was worth the width on a phone.

import { solarState } from "../data/solar";
import type { WeatherTimeline } from "../data/weather";

/** How far the scrubber reaches, in hours either side of the present. */
export const SCRUB_BACK_H = 6;
export const SCRUB_FWD_H = 54;

/** Hours drawn in the band, which is now the whole of the scrubber's range. */
const BAND_HOURS = SCRUB_BACK_H + SCRUB_FWD_H;

/**
 * The city's wall clock, formatted by `Intl` in the city's own IANA zone.
 *
 * Not by adding a fixed offset to a UTC instant. The scrubber reaches days
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
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    };
    // An invalid zone throws rather than falling back, and a bad zone string
    // off the wire must not take the whole HUD down with it.
    try {
      this.fmt = new Intl.DateTimeFormat("en-US", opts);
    } catch {
      this.fmt = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
    }
    try {
      this.zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" });
    } catch {
      this.zoneFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", timeZoneName: "short" });
    }
  }

  /** `time` is a 12-hour wall clock, "1:54 PM". `hour` stays 0..24 decimal. */
  parts(when: Date): { time: string; day: string; hour: number } {
    const p = this.fmt.formatToParts(when);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    const h12 = Number(get("hour"));
    const m = Number(get("minute"));
    // `dayPeriod` is the only part that says which half of the day this is;
    // 12 AM is hour 0 and 12 PM is hour 12, which is the one case a plain
    // "+12 if PM" gets wrong in both directions.
    const pm = /p/i.test(get("dayPeriod"));
    const h24 = (h12 % 12) + (pm ? 12 : 0);
    return {
      time: `${h12}:${String(m).padStart(2, "0")} ${pm ? "PM" : "AM"}`,
      day: get("weekday"),
      hour: h24 + m / 60,
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

const SPAN = BAND_HOURS * 3600;
const LO = -SCRUB_BACK_H * 3600;

export class Timebar {
  private root: HTMLDivElement;
  private clock: HTMLElement;
  private zone: HTMLElement;
  private offsetChip: HTMLElement;
  private band: HTMLElement;
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
        <b class="tb-time">--:--</b>
        <span class="tb-zone"></span>
        <span class="tb-offset">now</span>
      </div>
      <div class="tb-band"><div class="tb-cursor"></div></div>
      <div class="tb-ticks"></div>`;
    parent.append(this.root);

    this.clock = this.root.querySelector(".tb-time")!;
    this.zone = this.root.querySelector(".tb-zone")!;
    this.offsetChip = this.root.querySelector(".tb-offset")!;
    this.band = this.root.querySelector(".tb-band")!;
    this.cursor = this.root.querySelector(".tb-cursor")!;

    this.zone.textContent = this.clockFmt.abbrev(opts.base);

    this.buildBand();
    this.armDrag();
  }

  /**
   * One cell per hour, coloured by that hour's sky, plus a label wherever a
   * new day starts. The labels are what stop the band being an abstract smear:
   * "Sat" over a dark stretch is a night you can aim at.
   */
  private buildBand(): void {
    const { lat, lon, base, timeline } = this.opts;
    const ticks = this.root.querySelector(".tb-ticks")!;
    for (let i = 0; i < BAND_HOURS; i++) {
      const hoursFromBase = i - SCRUB_BACK_H;
      const t = new Date(base.getTime() + hoursFromBase * 3600_000);
      const solar = solarState(t, lat, lon);
      const wx = timeline?.at(t);
      const cell = document.createElement("i");
      cell.style.background = skyColour(solar.daylight, wx ? wx.totalCover : 0, solar.sun.altitude);
      const local = this.clockFmt.parts(t);
      cell.title = `${local.day} ${local.time} · ${wx ? wx.summary : "no forecast"}`;
      if (local.hour < 1) {
        cell.classList.add("day-start");
        const label = document.createElement("span");
        label.textContent = local.day;
        label.style.left = `${((i + 0.5) / BAND_HOURS) * 100}%`;
        ticks.append(label);
      }
      this.band.append(cell);
    }
    // The present is the one instant worth marking: it is where the picture is
    // real rather than predicted, and it is how you get back.
    const now = document.createElement("span");
    now.className = "tb-nowtick";
    now.textContent = "now";
    now.style.left = `${(-LO / SPAN) * 100}%`;
    ticks.append(now);
  }

  /**
   * The band is the control. Pointer events rather than a range input because
   * a range input on a phone is a 20 px thumb that has to be hit exactly;
   * pressing anywhere on the band jumps the clock there and keeps dragging,
   * which is the gesture the band's shape already suggests.
   */
  private armDrag(): void {
    const seek = (clientX: number) => {
      const r = this.band.getBoundingClientRect();
      const frac = (clientX - r.left) / Math.max(r.width, 1);
      this.setOffset(LO + Math.max(0, Math.min(1, frac)) * SPAN);
    };
    this.band.addEventListener("pointerdown", (e) => {
      this.band.setPointerCapture(e.pointerId);
      seek(e.clientX);
      e.preventDefault();
    });
    this.band.addEventListener("pointermove", (e) => {
      if (this.band.hasPointerCapture(e.pointerId)) seek(e.clientX);
    });
  }

  /** Clamped to the scrubber's range, then pushed out to the scene. */
  setOffset(seconds: number): void {
    this.offset = Math.max(LO, Math.min(LO + SPAN, seconds));
    this.opts.onOffset(this.offset);
  }

  get offsetSeconds(): number {
    return this.offset;
  }

  setTimelapse(on: boolean): void {
    this.root.classList.toggle("lapsing", on);
  }

  /** Called every few frames with the clock the scene is actually rendering. */
  update(now: Date, _sunAltitude: number): void {
    const p = this.clockFmt.parts(now);
    const label = `${p.day} ${p.time}`;
    if (this.clock.textContent !== label) this.clock.textContent = label;

    const off = offsetLabel(this.offset);
    if (this.offsetChip.textContent !== off) this.offsetChip.textContent = off;
    this.offsetChip.classList.toggle("shifted", Math.abs(this.offset) >= 60);

    this.cursor.style.left = `${((this.offset - LO) / SPAN) * 100}%`;
  }
}
