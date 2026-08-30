// An on-screen diagnostic, because a phone has no console.
//
// This exists because of a bug I could not otherwise see: the whole scene, the
// aeroplane included, rendered black on a phone while the identical code path
// (forced locally: `samples: 0`, the reduced ring plan) rendered correctly on a
// desktop. That means the fault is in the DEVICE's GL, not in the branch, and
// no amount of reasoning from a desktop reproduces it. The only way forward is
// to have the failing device say what it is and what it supports.
//
// It is deliberately dumb: no dependencies, no renderer state, and it draws
// itself even if the app never finished booting, since "nothing rendered at
// all" is one of the outcomes it has to report.

const EXTENSIONS = [
  "EXT_color_buffer_float",
  "EXT_color_buffer_half_float",
  "OES_texture_float_linear",
  "EXT_float_blend",
  "WEBGL_depth_texture",
];

function line(k: string, v: string): string {
  return `<div><span style="opacity:.6">${k}</span> ${v}</div>`;
}

/**
 * Render the panel. Safe to call before anything else has initialised, and
 * safe to call when WebGL is entirely unavailable, which is itself a finding.
 */
export function showDiagnostics(canvas: HTMLCanvasElement): void {
  const el = document.createElement("div");
  el.id = "diag";
  el.setAttribute(
    "style",
    "position:fixed;left:8px;top:8px;right:8px;z-index:9999;" +
      "font:11px/1.5 ui-monospace,monospace;color:#dfe6ee;" +
      "background:rgba(8,12,18,.92);border:1px solid rgba(255,255,255,.18);" +
      "border-radius:8px;padding:10px;max-height:70vh;overflow:auto;",
  );

  const rows: string[] = [];
  rows.push(line("ua", navigator.userAgent.slice(0, 120)));
  rows.push(line("dpr", String(devicePixelRatio)));
  rows.push(line("screen", `${innerWidth}x${innerHeight}`));
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  rows.push(line("deviceMemory", mem === undefined ? "unknown" : `${mem} GB`));
  rows.push(
    line(
      "pointer",
      typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
        ? "coarse (mobile plan)"
        : "fine (desktop plan)",
    ),
  );

  // A separate context from the app's, so probing here cannot disturb the real
  // one. It costs a context and is released immediately.
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
  } catch {
    gl = null;
  }

  if (!gl) {
    rows.push(line("webgl2", "<b style='color:#ff8a8a'>UNAVAILABLE</b>"));
  } else {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    rows.push(line("gpu", renderer.slice(0, 90)));
    rows.push(line("maxTexture", String(gl.getParameter(gl.MAX_TEXTURE_SIZE))));
    rows.push(
      line("maxRenderbuffer", String(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE))),
    );
    rows.push(line("maxSamples", String(gl.getParameter(gl.MAX_SAMPLES))));
    for (const name of EXTENSIONS) {
      const has = gl.getExtension(name) !== null;
      rows.push(
        line(
          name,
          has ? "yes" : "<b style='color:#ff8a8a'>NO</b>",
        ),
      );
    }
  }

  // Whatever the app managed to publish about itself. Absent means it never got
  // far enough to publish, which is the single most useful thing to know.
  const w = window as unknown as Record<string, unknown>;
  rows.push(line("app booted", w.flyby ? "yes" : "<b style='color:#ff8a8a'>NO</b>"));

  el.innerHTML = rows.join("");
  document.body.append(el);
}

/**
 * Surface the two failures that otherwise leave a silent black screen: a lost
 * GL context, and anything thrown after boot. Both are invisible on a phone.
 */
export function watchForFailures(canvas: HTMLCanvasElement): void {
  const shout = (what: string) => {
    let box = document.getElementById("diag-err");
    if (!box) {
      box = document.createElement("div");
      box.id = "diag-err";
      box.setAttribute(
        "style",
        "position:fixed;left:8px;right:8px;bottom:8px;z-index:10000;" +
          "font:11px/1.4 ui-monospace,monospace;color:#ffd9d9;" +
          "background:rgba(60,10,10,.94);border:1px solid #ff6b6b;" +
          "border-radius:8px;padding:8px;max-height:40vh;overflow:auto;",
      );
      document.body.append(box);
    }
    box.textContent = `${box.textContent ?? ""}\n${what}`.trim();
  };

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    shout("WEBGL CONTEXT LOST (usually out of GPU memory)");
  });
  addEventListener("error", (e) => shout(`error: ${e.message}`));
  addEventListener("unhandledrejection", (e) =>
    shout(`unhandled: ${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`),
  );
}
