// Catches a backtick inside a GLSL block, which is a comment that silently
// ends the shader.
//
// Every shader in this repo lives in a TypeScript template literal tagged with
// a glsl comment marker. A backtick anywhere inside one CLOSES the literal, so the rest
// of the shader becomes TypeScript and the file stops parsing. That part is
// fine: tsc does reject it. What is not fine is the error it gives, which is
// "',' expected" pointing at whatever line the resulting garbage first fails
// on, routinely hundreds of lines below the actual mistake and in a completely
// different function.
//
// It has cost two debugging rounds so far, both times writing an ordinary
// comment about a uniform and quoting its name the way one quotes an
// identifier in prose. The habit is correct everywhere else in the codebase,
// which is exactly why it recurs.
//
// So this is not a second opinion on tsc. It is the same failure reported at
// the line that caused it.

declare const process: {
  argv: string[];
  exit(code?: number): never;
};
declare const Bun: {
  file(path: string): { text(): Promise<string> };
};

import { readdirSync, statSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("../", import.meta.url).pathname);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Find every glsl-tagged template literal and report backticks inside it.
 *
 * The scan is deliberately dumb: from the marker, walk forward to the opening
 * backtick, then forward again to the first UNESCAPED backtick, and treat that
 * as the end. A stray backtick therefore looks like an early close, and the
 * text after it will not be GLSL. Rather than try to prove that, the rule is
 * simpler and stricter: a GLSL block must not contain a backtick that is not
 * its own terminator, and the terminator must be followed by something that
 * looks like the end of an expression.
 */
interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan(src: string, file: string): Finding[] {
  const found: Finding[] = [];
  const marker = /\/\*\s*glsl\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src)) !== null) {
    const open = src.indexOf("`", m.index);
    if (open < 0) continue;
    // Walk to the terminator, allowing escaped backticks and skipping over
    // `${ ... }` interpolations, which legitimately contain arbitrary code.
    let i = open + 1;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
      if (c === "}" && depth > 0) { depth--; i++; continue; }
      if (c === "`" && depth === 0) break;
      i++;
    }
    // Everything between open and i is the shader body. A backtick can only
    // appear here if it was escaped, which is legal but confusing enough in a
    // shader that it is still worth reporting.
    const body = src.slice(open + 1, i);
    const bt = body.indexOf("\\`");
    if (bt >= 0) {
      const line = src.slice(0, open + 1 + bt).split("\n").length;
      found.push({ file, line, text: body.slice(Math.max(0, bt - 40), bt + 40).replace(/\n/g, " ") });
    }
    marker.lastIndex = i;
  }
  return found;
}

/**
 * The real check: a GLSL block whose terminator is followed by something other
 * than the end of an expression means the literal closed early, and the only
 * way that happens is a backtick in the body.
 */
function scanEarlyClose(src: string, file: string): Finding[] {
  const found: Finding[] = [];
  const marker = /\/\*\s*glsl\s*\*\/\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(src)) !== null) {
    const open = src.indexOf("`", m.index);
    if (open < 0) continue;
    let i = open + 1;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
      if (c === "}" && depth > 0) { depth--; i++; continue; }
      if (c === "`" && depth === 0) break;
      i++;
    }
    // A shader ends where the expression does: a semicolon, a comma, or a
    // closing bracket, give or take whitespace. Anything else means the
    // backtick we stopped at was not the real end of the shader.
    const after = src.slice(i + 1, i + 200).trimStart();
    if (after.length && !/^[;,)\]}]/.test(after)) {
      const line = src.slice(0, i).split("\n").length;
      found.push({
        file,
        line,
        text: src.slice(Math.max(0, i - 60), i + 1).split("\n").pop() ?? "",
      });
    }
    marker.lastIndex = i;
  }
  return found;
}

const files = walk(`${ROOT}src`).concat(walk(`${ROOT}tools`));
let bad = 0;
let blocks = 0;

for (const f of files) {
  const src = await Bun.file(f).text();
  const tagged = src.match(/\/\*\s*glsl\s*\*\/\s*`/g);
  if (!tagged) continue;
  blocks += tagged.length;
  const rel = f.slice(ROOT.length);
  for (const hit of [...scanEarlyClose(src, rel), ...scan(src, rel)]) {
    console.log(`FAIL ${hit.file}:${hit.line} a backtick ends the GLSL block here`);
    console.log(`     ...${hit.text.trim()}`);
    bad++;
  }
}

// A scan that finds no shaders would report success forever, which is the
// failure mode this repo keeps producing. Refuse to pass on zero.
if (blocks === 0) {
  console.log("FAIL found no /* glsl */ blocks at all; the scan is not looking at anything");
  bad++;
}

console.log(
  bad === 0
    ? `\nall ${blocks} glsl blocks close where they should`
    : `\n${bad} problem(s) across ${blocks} glsl blocks`,
);
process.exit(bad === 0 ? 0 : 1);
