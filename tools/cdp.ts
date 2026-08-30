// A minimum Chrome DevTools Protocol client: launch a headless Chrome, attach
// to one tab, evaluate expressions in it.
//
// Written by hand rather than pulled in as puppeteer because the whole surface
// this repo needs is "open a page, wait for a global, read a string back", and
// that is about eighty lines. A browser automation dependency would be an order
// of magnitude more code than the thing using it, and it would pin a Chromium
// download into a repo whose only other dependency is three.js.
//
// Headless Chrome on macOS reaches the real GPU through ANGLE's Metal backend
// (verified: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4)"), so a screenshot
// taken here is the same pipeline a person sees, not a software rasteriser
// approximating it.

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface CdpOptions {
  port: number;
  width: number;
  height: number;
  /** Persisted profile: the app's IndexedDB tile cache lives here. */
  profileDir: string;
  /**
   * Uncap the frame rate. Without this every frame is padded out to the
   * display's refresh interval and a frame-cost measurement can only ever
   * report 16.7 ms, however cheap the frame actually was.
   */
  uncapped?: boolean;
}

export class Cdp {
  /**
   * Everything the page logged at warning or worse, plus every console.error.
   *
   * This exists because of a specific failure: a fragment shader with one
   * reserved word in it fails to link, three.js logs the error and carries on,
   * and the page renders a city with NO BUILDINGS in it -- which the harness
   * screenshotted happily and would have compared against the previous set as
   * though it meant something. A screenshot tool that cannot tell "this looks
   * different" from "this is broken" is worse than no tool.
   */
  readonly problems: string[] = [];

  private ws!: WebSocket;
  private proc!: ReturnType<typeof Bun.spawn>;
  private sessionId!: string;
  private nextId = 0;
  private pending = new Map<number, (v: unknown) => void>();

  static async launch(opts: CdpOptions): Promise<Cdp> {
    const c = new Cdp();
    c.proc = Bun.spawn(
      [
        CHROME,
        `--remote-debugging-port=${opts.port}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        `--user-data-dir=${opts.profileDir}`,
        `--window-size=${opts.width},${opts.height}`,
        "--hide-scrollbars",
        "--use-angle=metal",
        ...(opts.uncapped ? ["--disable-gpu-vsync", "--disable-frame-rate-limit"] : []),
        "about:blank",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );

    let version: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 200 && !version; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${opts.port}/json/version`);
        if (r.ok) version = (await r.json()) as { webSocketDebuggerUrl: string };
      } catch {
        // Chrome has not opened the port yet; that is the normal case here.
      }
      if (!version) await Bun.sleep(100);
    }
    if (!version) throw new Error("headless Chrome never opened its debug port");

    c.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error("could not attach to Chrome"));
    });
    c.ws.onmessage = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as {
        id?: number; result?: unknown; error?: unknown;
        method?: string; params?: Record<string, unknown>;
      };
      if (m.method === "Log.entryAdded") {
        const entry = (m.params as { entry: { level: string; text: string } }).entry;
        if (entry.level === "error" || entry.level === "warning") {
          c.problems.push(`${entry.level}: ${entry.text}`);
        }
      }
      if (m.method === "Runtime.consoleAPICalled") {
        const p = m.params as { type: string; args: { value?: string; description?: string }[] };
        if (p.type === "error" || p.type === "warning") {
          c.problems.push(p.args.map((a) => a.value ?? a.description ?? "").join(" "));
        }
      }
      if (m.id !== undefined) {
        const done = c.pending.get(m.id);
        if (done) {
          c.pending.delete(m.id);
          done(m);
        }
      }
    };

    const target = (await c.raw("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const attached = (await c.raw("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    c.sessionId = attached.sessionId;
    await c.send("Runtime.enable");
    await c.send("Log.enable");
    return c;
  }

  private raw(method: string, params: unknown, sessionId?: string): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      this.pending.set(id, (msg) => {
        const m = msg as { result?: unknown; error?: { message: string } };
        if (m.error) rej(new Error(`${method}: ${m.error.message}`));
        else res(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  send(method: string, params: unknown = {}): Promise<unknown> {
    return this.raw(method, params, this.sessionId);
  }

  /** Evaluate in the page and bring the value back by value, not by handle. */
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result: { value: T };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    };
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.enable");
    await this.send("Page.navigate", { url });
  }

  /**
   * Poll an expression until it is truthy. Polling rather than an event,
   * because what "ready" means is a property of the app (it has drawn N frames)
   * and no protocol event knows about that.
   */
  async waitFor(expression: string, timeoutMs: number, label: string): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      let ok = false;
      try {
        ok = await this.eval<boolean>(`!!(${expression})`);
      } catch {
        // A navigation in flight makes evaluate throw; keep polling.
      }
      if (ok) return;
      if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(150);
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Already gone.
    }
    this.proc.kill();
  }
}
