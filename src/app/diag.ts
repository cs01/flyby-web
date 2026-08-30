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

import { deviceBudget, formatMiB } from "../render/budget";

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
  rows.push(line("screen", `${innerWidth}x${innerHeight}`));

  // The tier and everything derived from it. This is the half of the panel that
  // says what the app DECIDED, as against what the device can do, and the
  // estimated total is the number this whole exercise exists to produce: no
  // code anywhere used to know how much GPU memory a load was asking for.
  const budget = deviceBudget();
  const d = budget.device;
  rows.push(line("dpr", `${devicePixelRatio} capped to ${d.pixelRatio}`));
  rows.push(
    line("deviceMemory", d.deviceMemoryGb === null
      ? `unknown, assuming ${budget.assumedMemoryGb} GB`
      : `${d.deviceMemoryGb} GB`),
  );
  rows.push(line("pointer", d.coarsePointer ? "coarse" : "fine"));
  rows.push(line("<b>tier</b>", `<b>${budget.tier}</b>`));
  rows.push(line("tier because", budget.reasons.length ? budget.reasons.join("; ") : "nothing forced it down"));
  rows.push(
    line("drape rings", budget.rings.map((r) => `${r.extent}m@z${r.imageryZoom}`).join(" ")),
  );
  rows.push(line("msaa", budget.msaaSamples === 0 ? "off" : `${budget.msaaSamples}x`));
  rows.push(
    line("sun cascades", `${budget.shadowCascadeCount} x ${budget.shadowCascadeSize}`),
  );
  rows.push(
    line("aircraft probes", `env ${budget.aircraftEnvSize}, self-shadow ${budget.aircraftShadowSize}`),
  );
  rows.push(line("ambient occlusion", budget.aoEnabled ? "on" : "off"));
  rows.push(
    line(
      "triangle budget",
      `${(budget.buildingTriangleBudget / 1000).toFixed(0)}k buildings, ` +
      `${(budget.roadTriangleBudget / 1000).toFixed(0)}k roads`,
    ),
  );
  for (const item of budget.memory.items) {
    rows.push(line(`&nbsp;&nbsp;${item.what}`, formatMiB(item.bytes)));
  }
  rows.push(line("<b>gpu estimate</b>", `<b>${formatMiB(budget.memory.totalBytes)}</b>`));

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

  el.innerHTML = rows.join("");
  document.body.append(el);

  // The panel is built before the world is, so everything below has to be
  // re-read on a timer. Capabilities answer "what could go wrong"; these answer
  // "what actually did", which is the half that discriminates between a dead
  // parameter table, a night sky, and a miscompiled shader.
  const app = document.createElement("div");
  el.append(app);
  const refresh = () => {
    const w = window as unknown as {
      flyby?: {
        time?: Date;
        wx?: { totalCover?: number; precip?: number; tempC?: number };
        buildings?: { stats?: { drawn?: number; triangles?: number } };
        renderer?: { info?: { memory?: { textures?: number; geometries?: number } } };
      };
    };
    const f = w.flyby;
    const out: string[] = [];
    out.push(line("app booted", f ? "yes" : "<b style='color:#ff8a8a'>NO</b>"));
    if (f) {
      // H5: a black city at 22:00 with no lit windows may simply be night.
      out.push(line("scene time", String(f.time ?? "?")));
      if (f.wx) {
        out.push(line("cloud/precip", `${f.wx.totalCover?.toFixed(2)} / ${f.wx.precip?.toFixed(2)}`));
      }
      const st = f.buildings?.stats;
      out.push(
        line(
          "buildings drawn",
          st?.drawn
            ? `${st.drawn} (${st.triangles} tris)`
            : "<b style='color:#ff8a8a'>0 - pack missing or culled</b>",
        ),
      );
      const mem = f.renderer?.info?.memory;
      if (mem) out.push(line("gpu textures", `${mem.textures} tex / ${mem.geometries} geo`));
    }
    app.innerHTML = out.join("");
  };
  refresh();
  setInterval(refresh, 2000);
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

  // Shader compile and link failures, and GL errors, both vanish today: three
  // logs them to a console a phone cannot open, and an incomplete framebuffer
  // raises INVALID_FRAMEBUFFER_OPERATION that nothing ever reads. Route both to
  // the same visible box, because "black screen, no error" has already cost
  // this project several rounds of guessing.
  const w = window as unknown as { __flybyShout?: (s: string) => void };
  w.__flybyShout = shout;

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    shout("WEBGL CONTEXT LOST (usually out of GPU memory)");
  });
  addEventListener("error", (e) => shout(`error: ${e.message}`));
  addEventListener("unhandledrejection", (e) =>
    shout(`unhandled: ${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`),
  );
}
