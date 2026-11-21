// Which on-screen controls overlap, as numbers rather than as a screenshot.
//
// The phone layout went wrong by accretion: every panel was placed against a
// viewport corner and nobody could see that five of them landed on the same
// 60 px. This is the measure that would have said so. Pure, so the check in
// test/touch.check.ts runs it with a probe; the page runs it on real
// getBoundingClientRect boxes (window.flybyUi.overlaps, tools/phoneshots.ts).

export interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pairs that intersect by more than `slackPx` on both axes, and boxes that
 *  leave the viewport (safe area included) by more than that. */
export function auditBoxes(boxes: readonly Box[], vw: number, vh: number, slackPx = 1, inset = { top: 0, right: 0, bottom: 0, left: 0 }): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (a.x < inset.left - slackPx || a.y < inset.top - slackPx || a.x + a.w > vw - inset.right + slackPx || a.y + a.h > vh - inset.bottom + slackPx) {
      out.push(`${a.name} leaves the screen`);
    }
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > slackPx && oy > slackPx) out.push(`${a.name} x ${b.name}`);
    }
  }
  return out;
}
