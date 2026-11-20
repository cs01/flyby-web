// Self-bisecting safe mode for a device that kills the GPU context on load.
//
// The owner's phone loses its WebGL context on the first frame, and Chromium
// browsers then refuse to create ANY context for this site until the browser
// restarts. A manual bisect (one URL per feature) therefore costs a browser
// restart per step and never got run. Instead every crashed load moves the
// next load one rung down this ladder, and telemetry reports the rung, so the
// perf log shows which rung first survives.
//
// A crash is either a `webglcontextlost` event or a load that never reached
// SETTLE_S and never unloaded (the tab was killed outright). A normal close
// inside SETTLE_S fires `pagehide`, which disarms, so it is not counted.

export interface SafeRung {
  /** Names for the `off` set: passes and scene groups (see tools/profile.ts TOGGLES). */
  off: string[];
  /** Pinned render scale, or 0 for the adaptive one. */
  scale: number;
  msaa: boolean;
}

export const LADDER: SafeRung[] = [
  { off: [], scale: 0, msaa: true },
  { off: ["ao", "ssr", "shadow", "skyprobe", "cloudshadow"], scale: 0, msaa: true },
  {
    off: ["ao", "ssr", "shadow", "skyprobe", "cloudshadow", "clouds", "bloom", "aircraft", "foliage", "shrubs"],
    scale: 0.5,
    msaa: false,
  },
  {
    off: [
      "ao", "ssr", "shadow", "skyprobe", "cloudshadow", "clouds", "bloom", "aircraft", "foliage", "shrubs",
      "buildings", "traffic", "parkedcars", "transit", "lamps", "live", "airtraffic",
    ],
    scale: 0.35,
    msaa: false,
  },
];

export const SETTLE_S = 20;
const KEY = "flyby.safe";

interface Stored {
  level: number;
  /** True from load until SETTLE_S of rendering or a clean unload. */
  armed: boolean;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function read(kv: KV): Stored {
  try {
    const s = JSON.parse(kv.getItem(KEY) ?? "") as Stored;
    if (Number.isInteger(s.level) && typeof s.armed === "boolean") return s;
  } catch {}
  return { level: 0, armed: false };
}

function write(kv: KV, s: Stored): void {
  try {
    kv.setItem(KEY, JSON.stringify(s));
  } catch {}
}

const clamp = (n: number) => Math.max(0, Math.min(LADDER.length - 1, n));

export class SafeMode {
  readonly level: number;
  readonly rung: SafeRung;
  private settled = false;

  /** `override` is `?safe=N`; it replaces the stored level (`?safe=0` resets). */
  constructor(private readonly kv: KV, override: string | null) {
    const prev = read(kv);
    const n = override !== null && override !== "" ? Number(override) : NaN;
    // A load still armed from last time died without unloading: that is a crash too.
    this.level = Number.isFinite(n) ? clamp(n) : clamp(prev.armed ? prev.level + 1 : prev.level);
    this.rung = LADDER[this.level];
    write(kv, { level: this.level, armed: true });
  }

  /** The context was lost: the next load starts one rung lower. */
  lost(): void {
    this.settled = true;
    write(this.kv, { level: clamp(this.level + 1), armed: false });
  }

  /** A clean unload or SETTLE_S of frames: keep this rung, count nothing. */
  disarm(): void {
    if (this.settled) return;
    this.settled = true;
    write(this.kv, { level: this.level, armed: false });
  }

  frame(elapsedS: number): void {
    if (!this.settled && elapsedS >= SETTLE_S) this.disarm();
  }
}

/** Browser wiring; returns null for shot mode so tests stay deterministic. */
export function browserSafeMode(canvas: HTMLCanvasElement): SafeMode | null {
  const q = new URLSearchParams(location.search);
  if (q.has("shot")) return null;
  let kv: KV;
  try {
    kv = localStorage;
  } catch {
    return null;
  }
  const s = new SafeMode(kv, q.get("safe"));
  canvas.addEventListener("webglcontextlost", () => s.lost());
  addEventListener("pagehide", () => s.disarm());
  return s;
}
