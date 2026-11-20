// Anonymous frame-time beacon, so a slow phone reports itself.
//
// Sends samples per session (first frame, 25 s, 90 s of flying, and at once if
// the GL context is lost, which is the crash a 25 s timer never outlives) as a GET to
// the same-origin /flyby-feeds/t, which nginx answers 204 and logs WITHOUT the
// client address or user agent (deploy/nginx-flyby-feeds.conf). No cookie, no
// id: two samples cannot be joined to a person, and the second only says
// whether the quality controller settled. Skipped in shot mode, on localhost
// and with ?notelemetry, so tests and development never pollute the log.

export interface PerfSample {
  /** boot, tick or lost. */
  ev: string;
  /** The page's own query string (city, off, scale...), so a bisect run says which flags it ran with. */
  q: string;
  /** The budget's own GPU memory estimate for this device and tier, MiB. */
  est: number;
  /** Seconds the page had been flying when sampled. */
  t: number;
  city: string;
  tier: string;
  /** Quality ladder index and its render scale. */
  level: number;
  scale: number;
  /** Frame time percentiles over the last 10 s, milliseconds. */
  p50: number;
  p95: number;
  /** Frames the 10 s window held, to tell a 60 Hz panel from a stalled tab. */
  n: number;
  /** Coarse device facts, enough to group results by phone class. */
  mobile: number;
  w: number;
  h: number;
  dpr: number;
  cores: number;
  mem: number;
  gpu: string;
}

const WINDOW_S = 10;
const SEND_AT_S = [0, 25, 90];

export function percentile(sorted: ArrayLike<number>, n: number, p: number): number {
  if (n === 0) return 0;
  return sorted[Math.min(n - 1, Math.floor(p * n))];
}

export class Telemetry {
  private times: number[] = [];
  private stamps: number[] = [];
  private elapsed = 0;
  private sent = 0;
  private readonly enabled: boolean;
  // Read once up front: after a context loss getParameter returns nothing.
  private readonly gpu: string;

  constructor(
    private readonly gl: WebGLRenderingContext | WebGL2RenderingContext,
    private readonly ctx: () => Pick<PerfSample, "city" | "tier" | "level" | "scale" | "est">,
  ) {
    const q = new URLSearchParams(location.search);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    this.enabled = !q.has("shot") && !q.has("notelemetry") && !local;
    this.gpu = this.gpuName();
    if (this.enabled) {
      this.gl.canvas.addEventListener("webglcontextlost", () => this.send("lost"));
    }
  }

  /** Call once per rendered frame with the raw frame time in ms. A hidden tab pauses the clock. */
  frame(rawMs: number, dt: number): void {
    if (!this.enabled || this.sent >= SEND_AT_S.length) return;
    if (document.hidden) return;
    this.elapsed += dt;
    this.times.push(rawMs);
    this.stamps.push(this.elapsed);
    while (this.stamps.length && this.stamps[0] < this.elapsed - WINDOW_S) {
      this.stamps.shift();
      this.times.shift();
    }
    if (this.elapsed >= SEND_AT_S[this.sent]) {
      this.send(this.sent === 0 ? "boot" : "tick");
      this.sent++;
    }
  }

  private gpuName(): string {
    try {
      const ext = this.gl.getExtension("WEBGL_debug_renderer_info");
      const s = ext ? String(this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
      return s.slice(0, 80);
    } catch {
      return "unknown";
    }
  }

  private send(ev: string): void {
    const sorted = Float64Array.from(this.times).sort();
    const n = sorted.length;
    const c = this.ctx();
    const nav = navigator as Navigator & { deviceMemory?: number };
    const s: PerfSample = {
      ev,
      q: location.search.slice(1, 80),
      t: Math.round(this.elapsed),
      ...c,
      scale: Math.round(c.scale * 100) / 100,
      p50: Math.round(percentile(sorted, n, 0.5) * 10) / 10,
      p95: Math.round(percentile(sorted, n, 0.95) * 10) / 10,
      n,
      mobile: matchMedia("(pointer: coarse)").matches ? 1 : 0,
      w: innerWidth,
      h: innerHeight,
      dpr: Math.round(devicePixelRatio * 100) / 100,
      cores: nav.hardwareConcurrency ?? 0,
      mem: nav.deviceMemory ?? 0,
      gpu: this.gpu,
    };
    const qs = new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)]));
    // keepalive: the 90 s sample can race a tab close.
    fetch(`/flyby-feeds/t?${qs}`, { keepalive: true, cache: "no-store" }).catch(() => {});
  }
}
