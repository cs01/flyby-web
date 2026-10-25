// The gate on the adaptive quality ladder in src/render/quality.ts.
//
// Pure: the controller only reads a pixel ratio off the renderer, so a stub
// stands in for it and every claim is a frame-time trace fed by hand. Each
// claim carries a vacuity probe: the same measurement on a case where the
// claim could not hold, asserted to come out the other way.

import type * as THREE from "three";
import { AdaptiveQuality, FULL_FEATURES, buildLadder } from "../src/render/quality";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(60)} ${detail}`);
  if (!ok) failures++;
}

const renderer = (ratio: number) => ({ getPixelRatio: () => ratio }) as unknown as THREE.WebGLRenderer;
const FULL = { ssr: true, ao: true, fullClouds: true, bigShadows: true, msaa: true };
const PHONE = { ssr: false, ao: false, fullClouds: false, bigShadows: false, msaa: false };

/** Feed `n` frames of `ms` each; returns how many times the step changed. */
function run(q: AdaptiveQuality, ms: number, n: number, refreshMs = ms): number {
  let changes = 0;
  for (let i = 0; i < n; i++) if (q.update(ms, Math.max(ms, refreshMs) / 1000, Math.max(ms, refreshMs))) changes++;
  return changes;
}

// 1. Features go before resolution.
{
  const ladder = buildLadder(1.5, FULL);
  const firstScaled = ladder.findIndex((s) => s.scale < 1);
  const allOffBefore = ladder.slice(0, firstScaled).at(-1)!.features;
  check(
    "every feature is shed before the first resolution step",
    firstScaled === 6 && !allOffBefore.ssr && allOffBefore.lowClouds && !allOffBefore.ao && allOffBefore.lowShadows &&
      !allOffBefore.msaa,
    `first scale step at index ${firstScaled}, features there ${JSON.stringify(allOffBefore)}`,
  );
  const lowest = ladder.at(-1)!.scale * 1.5;
  check("the floor stays at or above one device pixel per CSS pixel", lowest >= 1 - 1e-6, `${lowest.toFixed(2)} at dpr 1.5`);
  const phone = buildLadder(1.5, PHONE);
  check(
    "a phone's ladder has no step for a feature it never had",
    phone.length === 3 && phone[1].scale < 1,
    `${phone.length} steps, the second at scale ${phone[1].scale}`,
  );
  check("  probe: the desktop ladder is longer", ladder.length > phone.length, `${ladder.length} against ${phone.length}`);
}

// 2. A sustained slow run sheds the cascades first, a single slow frame sheds nothing.
{
  const q = new AdaptiveQuality(renderer(1.5), "full", FULL);
  run(q, 16.7, 60);
  q.update(40, 0.04, 40);
  run(q, 16.7, 20);
  check("one slow frame changes nothing", q.level === 0, `level ${q.level}`);
  run(q, 25, 40);
  check(
    "a sustained 25 ms run sheds the big cascades and nothing else",
    q.level === 1 && q.features.lowShadows && q.features.ao && q.features.ssr && q.scale === 1,
    `level ${q.level}, ${JSON.stringify(q.features)}, scale ${q.scale}`,
  );
}

// 3. Back up again on a 60 Hz display. The frames report 16.7 ms whatever the
//    GPU is doing, so "under 12 ms" never happens; running AT the refresh is
//    the headroom signal. Probe: the same 16.7 ms frames on a 120 Hz display,
//    where 16.7 is half rate and is not headroom.
{
  const at60 = new AdaptiveQuality(renderer(1.5), "full", FULL);
  run(at60, 25, 300);
  const low = at60.level;
  run(at60, 16.7, 900, 16.7);
  check("steps back up on a 60 Hz display", low >= 3 && at60.level < low, `level ${low} -> ${at60.level}`);
  const at120 = new AdaptiveQuality(renderer(1.5), "full", FULL);
  run(at120, 25, 300);
  const low120 = at120.level;
  for (let i = 0; i < 60; i++) at120.update(16.7, 1 / 120, 8.3);
  run(at120, 16.7, 900);
  check("  probe: half rate on a 120 Hz display is not headroom", at120.level === low120, `level ${low120} -> ${at120.level}`);
}

// 4. A step up that does not fit backs off: the second attempt waits longer.
{
  const q = new AdaptiveQuality(renderer(1.5), "full", FULL);
  run(q, 25, 60);
  const settled = q.level;
  // At refresh, then the step up proves slow, twice; count frames to each retry.
  const framesToUp = (): number => {
    for (let i = 1; i < 10000; i++) {
      const before = q.level;
      q.update(16.7, 1 / 60, 16.7);
      if (q.level < before) return i;
    }
    return -1;
  };
  const first = framesToUp();
  // 3 s of cooldown at 25 ms is 120 frames, then 31 slow ones step it down.
  run(q, 25, 160);
  const bounced = q.level === settled;
  const second = framesToUp();
  check(
    "a step up that bounces doubles the wait before the next try",
    // 180 frames is the base wait; the first retry also sits out the cooldown.
    settled === 1 && bounced && first > 0 && first < 360 && second >= 360,
    `${first} frames to the first retry, ${second} to the second`,
  );
}

// 5. A pinned controller never moves and holds every feature on.
{
  const q = new AdaptiveQuality(renderer(1.5), "full", FULL);
  q.pin(1);
  run(q, 50, 600);
  check(
    "pinned holds scale and features",
    q.scale === 1 && JSON.stringify(q.features) === JSON.stringify(FULL_FEATURES),
    `scale ${q.scale}, ${JSON.stringify(q.features)}`,
  );
  const free = new AdaptiveQuality(renderer(1.5), "full", FULL);
  run(free, 50, 600);
  check("  probe: unpinned, the same trace walks the ladder", free.level > 2, `level ${free.level}`);
}

console.log(failures === 0 ? "\nquality: all checks passed" : `\nquality: ${failures} FAILED`);
if (failures) process.exit(1);
