// Gate on src/app/safemode.ts: a crash steps down one rung, a clean load or
// close does not, a silent kill counts as a crash, ?safe=N overrides.

import { LADDER, RECOVER_RUNS, SETTLE_S, SafeMode, type KV } from "../src/app/safemode";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(60)} ${detail}`);
  if (!ok) failures++;
}

function store(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

let kv = store();
check("fresh device starts at rung 0", new SafeMode(kv, null).level === 0, "");

kv = store();
new SafeMode(kv, null).lost();
check("context loss steps down one rung", new SafeMode(kv, null).level === 1, "");

kv = store();
new SafeMode(kv, null); // killed: no lost, no pagehide, no settle
check("silent kill counts as a crash", new SafeMode(kv, null).level === 1, "");

kv = store();
let s = new SafeMode(kv, null);
s.frame(SETTLE_S - 1);
s.disarm(); // pagehide: user closed it
check("clean close keeps rung 0", new SafeMode(kv, null).level === 0, "");

kv = store();
s = new SafeMode(kv, null);
s.frame(SETTLE_S);
s.lost(); // loss after settling still steps down
check("loss after settle still steps down", new SafeMode(kv, null).level === 1, "");

kv = store();
for (let i = 0; i < 10; i++) new SafeMode(kv, null).lost();
check("ladder clamps at the last rung", new SafeMode(kv, null).level === LADDER.length - 1, "");

kv = store();
new SafeMode(kv, null).lost();
check("?safe=0 resets", new SafeMode(kv, "0").level === 0, "");
check("?safe=2 overrides", new SafeMode(store(), "2").level === 2, "");

// Vacuity probe: rung 0 must disable nothing, otherwise every user is degraded.
check("rung 0 disables nothing", LADDER[0].off.length === 0 && LADDER[0].scale === 0 && LADDER[0].msaa, "");
check("each rung disables at least as much as the last",
  LADDER.every((r, i) => i === 0 || LADDER[i - 1].off.every((n) => r.off.includes(n))), "");

const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
check("blocked storage does not throw", new SafeMode(bad, null).level === 0, "");

// Recovery: a rung is not forever.
kv = store();
new SafeMode(kv, null).lost();
new SafeMode(kv, null).lost(); // now at 2
for (let i = 0; i < RECOVER_RUNS; i++) new SafeMode(kv, null).frame(SETTLE_S);
check("RECOVER_RUNS good loads step back up one rung", new SafeMode(kv, null).level === 1, "");
kv = store();
new SafeMode(kv, null).lost();
for (let i = 0; i < RECOVER_RUNS - 1; i++) new SafeMode(kv, null).frame(SETTLE_S);
check("fewer good loads keep the rung", new SafeMode(kv, null).level === 1, "");
kv = store();
new SafeMode(kv, null).lost();
for (let i = 0; i < RECOVER_RUNS; i++) { const m = new SafeMode(kv, null); m.frame(SETTLE_S - 1); m.disarm(); }
check("closes before settling are not good loads", new SafeMode(kv, null).level === 1, "");
kv = store();
new SafeMode(kv, null).lost();
new SafeMode(kv, null).frame(SETTLE_S);
new SafeMode(kv, null).lost(); // crash resets the streak and steps down
new SafeMode(kv, null).frame(SETTLE_S);
new SafeMode(kv, null).frame(SETTLE_S);
check("a crash resets the good streak", new SafeMode(kv, null).level === 2, "");

if (failures) {
  console.log(`${failures} safemode check(s) failed`);
  process.exit(1);
}
console.log("safemode: all checks pass");
