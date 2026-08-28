// The instrument overlay: the numbers a pilot flies on, drawn as SVG.
//
// Three instruments, chosen because they are the three a pilot actually looks
// at and because each answers a question the raw numbers cannot:
//
//   ATTITUDE   which way is up, at a glance, with the FLIGHT PATH marked on
//              it. The nose and the flight path are not the same thing in
//              wind, and the gap between them is the wind doing something --
//              the most legible evidence in the app that the weather is real.
//   HEADING    a ribbon, not a number, because the useful question is "which
//              way am I turning and how fast", and a ribbon shows the rate.
//   VERTICAL   a tape with a needle, because climb rate is the one quantity
//              where the SIGN matters more than the value and a signed number
//              is slower to read than a needle above or below a centre line.
//
// Everything is updated by writing transforms and text, never innerHTML: this
// runs every frame, and rebuilding the markup 60 times a second would drop
// frames and defeat the point of a HUD that reads instantly.

const DEG = Math.PI / 180;

/** Pixels per degree on the attitude ball, chosen so +-30 deg fills it. */
const AI_PX_PER_DEG = 1.62;
/** Pixels per degree on the heading ribbon. */
const HDG_PX_PER_DEG = 2.0;

export interface OsdState {
  /** Nose-up positive, degrees. */
  pitchDeg: number;
  /** Right-wing-down positive, degrees. */
  rollDeg: number;
  headingDeg: number;
  /** Metres AMSL and AGL. */
  altM: number;
  aglM: number;
  /** Metres per second. */
  groundSpeed: number;
  airspeed: number;
  verticalSpeed: number;
  /** Degrees per second, measured. */
  rollRateDps: number;
  pitchRateDps: number;
  yawRateDps: number;
  /** Climb angle of the actual flight path, degrees. */
  flightPathDeg: number;
  /** Load factor, g. */
  gLoad: number;
  /** Degrees between where the nose points and where it is actually going. */
  driftDeg: number;
  /** Wind at the aircraft: direction it comes FROM, and speed in m/s. */
  windDirDeg: number;
  windSpeed: number;
  boost: boolean;
}

const KTS = 1.94384;
const FT = 3.28084;
const FPM = 196.85; // m/s -> feet per minute

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export function compassPoint(deg: number): string {
  const pts = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return pts[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export class Osd {
  readonly root: HTMLDivElement;

  private horizon!: SVGElement;
  private rollPtr!: SVGElement;
  private pathMarker!: SVGElement;
  private hdgTape!: SVGElement;
  private hdgText!: HTMLElement;
  private vsNeedle!: SVGElement;
  private vsText!: HTMLElement;

  /** The readouts that are plain text, by key. */
  private cells = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "osd";
    this.root.innerHTML = `
      <div class="osd-left"></div>
      <div class="osd-mid">
        <div class="osd-hdg"></div>
        <div class="osd-ai"></div>
      </div>
      <div class="osd-right"></div>`;
    parent.append(this.root);

    this.buildAttitude(this.root.querySelector(".osd-ai") as HTMLElement);
    this.buildHeading(this.root.querySelector(".osd-hdg") as HTMLElement);
    this.buildNumbers(this.root.querySelector(".osd-left") as HTMLElement, [
      ["ias", "IAS", "kt"],
      ["gs", "GS", "kt"],
      ["alt", "ALT", "ft"],
      ["agl", "AGL", "ft"],
    ]);
    this.buildNumbers(this.root.querySelector(".osd-right") as HTMLElement, [
      ["vs", "V/S", "fpm"],
      ["rates", "P/R/Y", "°/s"],
      ["wind", "WIND", ""],
      ["drift", "DRIFT", ""],
    ]);
    this.buildVsi(this.root.querySelector(".osd-right") as HTMLElement);
  }

  private buildNumbers(host: HTMLElement, rows: [string, string, string][]): void {
    for (const [key, label, unit] of rows) {
      const row = document.createElement("div");
      row.className = "row";
      const l = document.createElement("span");
      l.textContent = label;
      const v = document.createElement("b");
      v.textContent = "—";
      row.append(l, v);
      if (unit) {
        const u = document.createElement("i");
        u.textContent = unit;
        row.append(u);
      }
      host.append(row);
      this.cells.set(key, v);
    }
  }

  private buildAttitude(host: HTMLElement): void {
    const s = svg("svg", { viewBox: "-62 -62 124 124", class: "ai" });

    const defs = svg("defs", {});
    const clip = svg("clipPath", { id: "ai-clip" });
    clip.append(svg("circle", { r: 52, cx: 0, cy: 0 }));
    defs.append(clip);
    s.append(defs);

    const clipped = svg("g", { "clip-path": "url(#ai-clip)" });
    const horizon = svg("g", {});

    // The ball is drawn far larger than the window it shows through, so a full
    // 30 degrees of pitch cannot run the sky or the ground off the end of it.
    horizon.append(svg("rect", { x: -200, y: -320, width: 400, height: 320, class: "ai-sky" }));
    horizon.append(svg("rect", { x: -200, y: 0, width: 400, height: 320, class: "ai-gnd" }));
    horizon.append(svg("line", { x1: -200, y1: 0, x2: 200, y2: 0, class: "ai-horizon" }));

    for (let d = -30; d <= 30; d += 10) {
      if (d === 0) continue;
      const y = -d * AI_PX_PER_DEG;
      const half = d % 20 === 0 ? 20 : 11;
      horizon.append(svg("line", { x1: -half, y1: y, x2: half, y2: y, class: "ai-ladder" }));
      if (d % 20 === 0) {
        const t = svg("text", { x: half + 4, y: y + 3, class: "ai-num" });
        t.textContent = String(Math.abs(d));
        horizon.append(t);
      }
    }
    clipped.append(horizon);
    s.append(clipped);
    this.horizon = horizon;

    // Bank scale: fixed ticks, moving pointer.
    for (const a of [-30, -20, -10, 0, 10, 20, 30]) {
      const r0 = 52;
      const r1 = a === 0 ? 42 : a % 20 === 0 ? 45 : 47.5;
      const rad = (a - 90) * DEG;
      s.append(
        svg("line", {
          x1: Math.cos(rad) * r0,
          y1: Math.sin(rad) * r0,
          x2: Math.cos(rad) * r1,
          y2: Math.sin(rad) * r1,
          class: "ai-tick",
        }),
      );
    }
    const ptr = svg("path", { d: "M0,-50 L-4.5,-42 L4.5,-42 Z", class: "ai-ptr" });
    s.append(ptr);
    this.rollPtr = ptr;

    // Fixed reference: the aircraft itself, which never moves in the frame.
    s.append(svg("path", { d: "M-26,0 L-9,0 M9,0 L26,0 M0,-3 L0,3", class: "ai-ref" }));
    s.append(svg("circle", { r: 52, cx: 0, cy: 0, class: "ai-ring" }));

    // Flight path marker: where the aeroplane is actually going, as opposed to
    // where its nose is pointing. In still air it sits on the reference; in a
    // crosswind it slides off to one side by exactly the drift angle, and in a
    // climb it rides above. It is the one mark that shows the WIND.
    const fpm = svg("g", { class: "ai-fpm" });
    fpm.append(svg("circle", { r: 3.2, cx: 0, cy: 0 }));
    fpm.append(svg("path", { d: "M-8,0 L-3.4,0 M3.4,0 L8,0 M0,-3.4 L0,-7" }));
    s.append(fpm);
    this.pathMarker = fpm;

    host.append(s);
  }

  private buildHeading(host: HTMLElement): void {
    const s = svg("svg", { viewBox: "-110 -15 220 30", class: "hdg" });
    const tape = svg("g", {});
    // Ticks are laid from -180 to +540 so the tape is continuous across the
    // wrap at north. Generating only 0..360 leaves a gap you fly into.
    for (let d = -180; d <= 540; d += 5) {
      const x = d * HDG_PX_PER_DEG;
      const major = d % 30 === 0;
      tape.append(svg("line", { x1: x, y1: 5, x2: x, y2: major ? -3 : 1, class: "hdg-tick" }));
      if (major) {
        const t = svg("text", { x, y: -6, class: "hdg-num" });
        const v = ((d % 360) + 360) % 360;
        t.textContent = v % 90 === 0 ? ["N", "E", "S", "W"][v / 90] : String(v / 10);
        tape.append(t);
      }
    }
    s.append(tape);
    s.append(svg("path", { d: "M0,-11 L-4,-15 L4,-15 Z", class: "hdg-ptr" }));
    this.hdgTape = tape;
    host.append(s);

    const box = document.createElement("div");
    box.className = "hdg-box";
    box.textContent = "---°";
    host.append(box);
    this.hdgText = box;
  }

  private buildVsi(host: HTMLElement): void {
    const wrap = document.createElement("div");
    wrap.className = "vsi";
    const s = svg("svg", { viewBox: "-16 -46 32 92", class: "vsi-svg" });
    s.append(svg("line", { x1: 0, y1: -42, x2: 0, y2: 42, class: "vsi-axis" }));
    // Ticks at 5 m/s, labelled in whole thousands of feet per minute, which is
    // the unit anyone reading a climb rate already thinks in.
    for (let v = -15; v <= 15; v += 5) {
      const y = -v * 2.7;
      s.append(svg("line", { x1: -6, y1: y, x2: 6, y2: y, class: v === 0 ? "vsi-zero" : "vsi-tick" }));
    }
    const needle = svg("path", { d: "M-10,0 L0,-4 L10,0 L0,4 Z", class: "vsi-needle" });
    s.append(needle);
    this.vsNeedle = needle;
    wrap.append(s);
    const t = document.createElement("div");
    t.className = "vsi-text";
    t.textContent = "0";
    wrap.append(t);
    host.append(wrap);
    this.vsText = t;
  }

  private set(key: string, text: string): void {
    const e = this.cells.get(key);
    if (e && e.textContent !== text) e.textContent = text;
  }

  update(s: OsdState): void {
    // Attitude. Roll rotates the whole ball; pitch slides it. Both are applied
    // in that order so the ladder stays square to the horizon.
    this.horizon.setAttribute(
      "transform",
      `rotate(${(-s.rollDeg).toFixed(2)}) translate(0 ${(s.pitchDeg * AI_PX_PER_DEG).toFixed(2)})`,
    );
    this.rollPtr.setAttribute("transform", `rotate(${(-s.rollDeg).toFixed(2)})`);

    // The flight path marker is placed at the same scale as the pitch ladder,
    // so its offset from the centre reads directly as degrees of drift and of
    // climb angle. Clamped, because a 90-degree drift at a standstill would
    // throw it off the instrument entirely.
    const fx = Math.max(-24, Math.min(24, s.driftDeg * AI_PX_PER_DEG));
    const fy = Math.max(-24, Math.min(24, -s.flightPathDeg * AI_PX_PER_DEG));
    this.pathMarker.setAttribute("transform", `translate(${fx.toFixed(2)} ${fy.toFixed(2)})`);

    // Heading ribbon slides under a fixed pointer.
    this.hdgTape.setAttribute("transform", `translate(${(-s.headingDeg * HDG_PX_PER_DEG).toFixed(2)} 0)`);
    const hdg = String(Math.round(s.headingDeg) % 360).padStart(3, "0");
    if (this.hdgText.textContent !== `${hdg}°`) this.hdgText.textContent = `${hdg}°`;

    // Vertical speed.
    const vClamped = Math.max(-15, Math.min(15, s.verticalSpeed));
    this.vsNeedle.setAttribute("transform", `translate(0 ${(-vClamped * 2.7).toFixed(2)})`);
    const fpm = Math.round((s.verticalSpeed * FPM) / 10) * 10;
    const vsLabel = `${fpm > 0 ? "+" : ""}${fpm}`;
    if (this.vsText.textContent !== vsLabel) this.vsText.textContent = vsLabel;
    this.vsText.classList.toggle("up", fpm > 40);
    this.vsText.classList.toggle("down", fpm < -40);

    this.set("ias", String(Math.round(s.airspeed * KTS)));
    this.set("gs", String(Math.round(s.groundSpeed * KTS)));
    this.set("alt", Math.round(s.altM * FT).toLocaleString());
    this.set("agl", Math.round(s.aglM * FT).toLocaleString());
    this.set("vs", vsLabel);
    this.set(
      "rates",
      `${Math.round(s.rollRateDps)}/${Math.round(s.pitchRateDps)}/${Math.round(s.yawRateDps)}`,
    );
    this.set("wind", `${compassPoint(s.windDirDeg)} ${Math.round(s.windSpeed * KTS)} kt`);
    // Drift only means something once there is a flight path to drift off.
    this.set(
      "drift",
      s.groundSpeed < 2 ? "—" : `${s.driftDeg > 0 ? "R" : "L"} ${Math.abs(Math.round(s.driftDeg))}°`,
    );

    this.root.classList.toggle("boost", s.boost);
  }
}
