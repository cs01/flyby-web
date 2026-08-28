// The instrument panel, drawn as SVG.
//
// Round dials with needles, not a column of numbers, and the reason is that a
// needle answers a different question from the figure it is pointing at. A
// pilot almost never wants to know that the airspeed is 103 knots; they want
// to know it is in the green arc and not moving, and a needle says that in one
// glance without being read. The numbers are still there -- an altimeter that
// cannot be read exactly is a toy -- but they have stopped being the primary
// instrument.
//
// The layout is the standard six-pack minus the two this app has no use for
// (there is no engine and no turn coordinator that the attitude ball does not
// already answer):
//
//   AIRSPEED   with the real arcs off a light single's placard: white for the
//              flap range, green for normal operation, yellow for the caution
//              range and a red radial at never-exceed. The arcs are what make
//              the dial readable without reading it.
//   ATTITUDE   which way is up, with the FLIGHT PATH marked on it. The nose
//              and the flight path are not the same thing in wind, and the gap
//              between them is the wind doing something -- the most legible
//              evidence in the app that the weather is real.
//   HEADING    a ribbon rather than a card, because the useful question is
//              "which way am I turning and how fast", and a ribbon shows rate.
//   ALTIMETER  two hands, hundreds and thousands, exactly as the instrument
//              works. A single hand would be easier to read and would not be
//              an altimeter.
//   VERTICAL   zero at nine o'clock, climb over the top: the sign is what
//              matters and a needle above or below the horizontal reads faster
//              than a signed number.
//
// Everything is updated by writing transforms and text, never innerHTML: this
// runs every frame, and rebuilding the markup 60 times a second would drop
// frames and defeat the point of an instrument that reads instantly.

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

// --- Airspeed dial ---------------------------------------------------------
// Knots at each end of the sweep, and how far round the sweep goes. 340
// degrees leaves a gap at the bottom for the caption, which is where a real
// instrument puts its maker's name for the same reason.
const ASI_MIN = 20;
const ASI_MAX = 180;
const ASI_SWEEP = 340;

/** Placard speeds off a light single, which is what this aeroplane is. */
const V_S0 = 33; // stall, flaps down: bottom of the white arc
const V_FE = 85; // maximum flaps extended: top of the white arc
const V_S1 = 44; // stall, clean: bottom of the green arc
const V_NO = 129; // maximum structural cruise: top of green, bottom of yellow
const V_NE = 163; // never exceed: the red radial

/** Full-scale rate on the vertical speed dial, feet per minute. */
const VSI_FULL = 4000;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** Zero is twelve o'clock and positive is clockwise, like every dial. */
function polar(angleDeg: number, r: number): { x: number; y: number } {
  return { x: Math.sin(angleDeg * DEG) * r, y: -Math.cos(angleDeg * DEG) * r };
}

function arcPath(a0: number, a1: number, r: number): string {
  const p0 = polar(a0, r);
  const p1 = polar(a1, r);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${p0.x.toFixed(2)},${p0.y.toFixed(2)} A${r},${r} 0 ${large} 1 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`;
}

function tick(a: number, r0: number, r1: number, cls: string): SVGElement {
  const p0 = polar(a, r0);
  const p1 = polar(a, r1);
  return svg("line", { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, class: cls });
}

function label(a: number, r: number, text: string, cls: string): SVGElement {
  const p = polar(a, r);
  const t = svg("text", { x: p.x, y: p.y + 2.6, class: cls });
  t.textContent = text;
  return t;
}

/** Bezel, face and caption. Every dial starts the same way. */
function dial(host: HTMLElement, caption: string): SVGElement {
  const wrap = document.createElement("div");
  wrap.className = "gz-wrap";
  const s = svg("svg", { viewBox: "-50 -50 100 100", class: "gz" });
  s.append(svg("circle", { r: 47, cx: 0, cy: 0, class: "gz-bezel" }));
  s.append(svg("circle", { r: 44, cx: 0, cy: 0, class: "gz-face" }));
  wrap.append(s);
  const cap = document.createElement("div");
  cap.className = "gz-cap";
  cap.textContent = caption;
  wrap.append(cap);
  host.append(wrap);
  return s;
}

/** The pivot every needle turns on, drawn last so it sits over the needles. */
function hub(s: SVGElement): void {
  s.append(svg("circle", { r: 3.4, cx: 0, cy: 0, class: "gz-hub" }));
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

  private asiNeedle!: SVGElement;
  private asiText!: HTMLElement;
  private altHundreds!: SVGElement;
  private altThousands!: SVGElement;
  private altText!: HTMLElement;
  private vsiNeedle!: SVGElement;
  private vsiText!: HTMLElement;

  /** The readouts that are plain text, by key. */
  private cells = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "osd";
    this.root.innerHTML = `
      <div class="osd-row">
        <div class="osd-gauge osd-asi"></div>
        <div class="osd-mid">
          <div class="osd-hdg"></div>
          <div class="osd-ai"></div>
        </div>
        <div class="osd-gauge osd-alt"></div>
        <div class="osd-gauge osd-vsi"></div>
      </div>
      <div class="osd-strip"></div>`;
    parent.append(this.root);

    this.buildAsi(this.root.querySelector(".osd-asi") as HTMLElement);
    this.buildAttitude(this.root.querySelector(".osd-ai") as HTMLElement);
    this.buildHeading(this.root.querySelector(".osd-hdg") as HTMLElement);
    this.buildAltimeter(this.root.querySelector(".osd-alt") as HTMLElement);
    this.buildVsi(this.root.querySelector(".osd-vsi") as HTMLElement);
    this.buildStrip(this.root.querySelector(".osd-strip") as HTMLElement, [
      ["gs", "GS", "kt"],
      ["agl", "AGL", "ft"],
      ["wind", "WIND", ""],
      ["drift", "DRIFT", ""],
    ]);
  }

  /**
   * The numbers a dial cannot give you: groundspeed (which is not airspeed and
   * differs by exactly the wind), height above the ground rather than the sea,
   * and the wind and drift themselves. One line, because they are reference
   * rather than instruments.
   */
  private buildStrip(host: HTMLElement, rows: [string, string, string][]): void {
    for (const [key, name, unit] of rows) {
      const cell = document.createElement("div");
      cell.className = "strip-cell";
      const l = document.createElement("span");
      l.textContent = name;
      const v = document.createElement("b");
      v.textContent = "—";
      cell.append(l, v);
      if (unit) {
        const u = document.createElement("i");
        u.textContent = unit;
        cell.append(u);
      }
      host.append(cell);
      this.cells.set(key, v);
    }
  }

  private asiAngle(kt: number): number {
    const f = (Math.max(ASI_MIN, Math.min(ASI_MAX, kt)) - ASI_MIN) / (ASI_MAX - ASI_MIN);
    return -ASI_SWEEP / 2 + f * ASI_SWEEP;
  }

  private buildAsi(host: HTMLElement): void {
    const s = dial(host, "AIRSPEED KT");

    // Arcs before ticks, so the ticks read on top of them rather than under.
    // The white arc sits inside the green one because they overlap over most
    // of their length and a real instrument stacks them the same way.
    s.append(svg("path", { d: arcPath(this.asiAngle(V_S1), this.asiAngle(V_NO), 38), class: "gz-arc-green" }));
    s.append(svg("path", { d: arcPath(this.asiAngle(V_NO), this.asiAngle(V_NE), 38), class: "gz-arc-yellow" }));
    s.append(svg("path", { d: arcPath(this.asiAngle(V_S0), this.asiAngle(V_FE), 32), class: "gz-arc-white" }));
    s.append(tick(this.asiAngle(V_NE), 34, 41, "gz-redline"));

    for (let v = ASI_MIN; v <= ASI_MAX; v += 10) {
      const a = this.asiAngle(v);
      const major = v % 20 === 0;
      s.append(tick(a, major ? 33 : 36, 41, major ? "gz-tick-maj" : "gz-tick"));
      // Nothing labelled down in the gap at the bottom: that is where the
      // digits window sits, and a number under it is a number nobody can read.
      if (major && Math.abs(a) < 150) s.append(label(a, 25, String(v), "gz-num"));
    }

    const n = svg("path", { d: "M-2.6,3 L0,-36 L2.6,3 Z", class: "gz-needle" });
    s.append(n);
    hub(s);
    this.asiNeedle = n;

    const t = document.createElement("div");
    t.className = "gz-digits";
    t.textContent = "---";
    (host.querySelector(".gz-wrap") as HTMLElement).append(t);
    this.asiText = t;
  }

  private buildAltimeter(host: HTMLElement): void {
    const s = dial(host, "ALTITUDE FT");

    // One revolution is 1000 ft: ten numbered hundreds, five minor ticks of
    // 20 ft between each. That is the instrument, and getting the subdivision
    // wrong is what makes a drawn altimeter look like a clock.
    for (let i = 0; i < 50; i++) {
      const a = (i / 50) * 360;
      const major = i % 5 === 0;
      s.append(tick(a, major ? 33 : 37.5, 41, major ? "gz-tick-maj" : "gz-tick"));
      if (major) s.append(label(a, 25, String(i / 5), "gz-num"));
    }

    // Thousands: short and fat. Hundreds: long and thin. A real altimeter is
    // misread when the two hands are similar, and the fix is the same here.
    const th = svg("path", { d: "M-3.4,4 L0,-21 L3.4,4 Z", class: "gz-needle gz-needle-short" });
    const hu = svg("path", { d: "M-2,4 L0,-38 L2,4 Z", class: "gz-needle" });
    s.append(th, hu);
    hub(s);
    this.altThousands = th;
    this.altHundreds = hu;

    const t = document.createElement("div");
    t.className = "gz-digits";
    t.textContent = "---";
    (host.querySelector(".gz-wrap") as HTMLElement).append(t);
    this.altText = t;
  }

  private vsiAngle(fpm: number): number {
    const v = Math.max(-VSI_FULL, Math.min(VSI_FULL, fpm));
    return -90 + (v / VSI_FULL) * 180;
  }

  private buildVsi(host: HTMLElement): void {
    const s = dial(host, "CLIMB 1000 FPM");

    // Zero at nine o'clock, climb over the top, descent under the bottom, and
    // the two ends meet at three o'clock. Both halves are the same sweep, so
    // "level" is a horizontal needle and any deflection is immediately signed.
    for (let f = 0; f <= VSI_FULL; f += 500) {
      const major = f % 1000 === 0;
      for (const sign of f === 0 ? [1] : [1, -1]) {
        const a = this.vsiAngle(f * sign);
        s.append(tick(a, major ? 33 : 37, 41, major ? "gz-tick-maj" : "gz-tick"));
        if (major) s.append(label(a, 25, String(f / 1000), "gz-num"));
      }
    }

    // Drawn pointing UP, like every other needle here, because the rotation it
    // is given comes from polar() and polar() measures from twelve o'clock. A
    // needle modelled pointing at its own zero instead is 90 degrees out for
    // the whole scale, and reads plausibly enough to miss: level flight put it
    // straight up rather than straight out to the left.
    const n = svg("path", { d: "M-2.4,2.4 L0,-36 L2.4,2.4 Z", class: "gz-needle" });
    s.append(n);
    hub(s);
    this.vsiNeedle = n;

    const t = document.createElement("div");
    t.className = "gz-digits";
    t.textContent = "0";
    (host.querySelector(".gz-wrap") as HTMLElement).append(t);
    this.vsiText = t;
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

  private set(key: string, text: string): void {
    const e = this.cells.get(key);
    if (e && e.textContent !== text) e.textContent = text;
  }

  private setText(e: HTMLElement, text: string): void {
    if (e.textContent !== text) e.textContent = text;
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
    this.setText(this.hdgText, `${hdg}°`);

    // Airspeed.
    const kt = s.airspeed * KTS;
    this.asiNeedle.setAttribute("transform", `rotate(${this.asiAngle(kt).toFixed(2)})`);
    this.setText(this.asiText, String(Math.round(kt)));

    // Altitude. The hands come off the same number, which is the whole trick:
    // a two-hand altimeter is one value shown at two scales, not two readings.
    const ft = s.altM * FT;
    this.altHundreds.setAttribute("transform", `rotate(${(((ft % 1000) / 1000) * 360).toFixed(2)})`);
    this.altThousands.setAttribute("transform", `rotate(${(((ft % 10000) / 10000) * 360).toFixed(2)})`);
    this.setText(this.altText, Math.round(ft).toLocaleString());

    // Vertical speed.
    const fpm = Math.round((s.verticalSpeed * FPM) / 10) * 10;
    this.vsiNeedle.setAttribute("transform", `rotate(${this.vsiAngle(fpm).toFixed(2)})`);
    const vsLabel = `${fpm > 0 ? "+" : ""}${fpm}`;
    this.setText(this.vsiText, vsLabel);
    this.vsiText.classList.toggle("up", fpm > 40);
    this.vsiText.classList.toggle("down", fpm < -40);

    this.set("gs", String(Math.round(s.groundSpeed * KTS)));
    this.set("agl", Math.round(s.aglM * FT).toLocaleString());
    this.set("wind", `${compassPoint(s.windDirDeg)} ${Math.round(s.windSpeed * KTS)} kt`);
    // Drift only means something once there is a flight path to drift off.
    this.set(
      "drift",
      s.groundSpeed < 2 ? "—" : `${s.driftDeg > 0 ? "R" : "L"} ${Math.abs(Math.round(s.driftDeg))}°`,
    );

    this.root.classList.toggle("boost", s.boost);
  }
}
