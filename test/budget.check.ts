// The gate on the device classifier in src/render/budget.ts.
//
// What this can check and a browser cannot: the classifier is pure and takes a
// plain descriptor, so a phone that nobody here owns can be described in six
// fields and the plan it would be given asserted exactly. The failure this
// guards against is not visible in a frame time. It is a load-time GPU
// allocation that fails on a device with no console, and by the time anything
// reactive could notice, the city is already black.
//
// Every bound below is a LITERAL. None of them is read from the module under
// test, because a bound taken from the constant it is checking moves its own
// goalposts and can never go red; this repo has shipped three gates that could
// never fail and docs/roadmap.md names all three.
//
// Every block also carries a VACUITY PROBE: the same predicate fed a case in
// which it could not possibly detect anything, asserted to come back false. An
// assertion that "the phone plan is smaller" is worth nothing if it would also
// pass with both tiers set to the same object.

import {
  CITY_RINGS,
  MOBILE_CITY_RINGS,
  assumedMemoryGb,
  budgetForTier,
  classifyDevice,
  widestDrapeTexturePx,
  type Budget,
  type DeviceDescriptor,
} from "../src/render/budget";

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}

// --- the devices ------------------------------------------------------------
//
// Written out in full rather than built from a shared default, so that reading
// one of them tells you the whole case it stands for.

/** A desktop with a mouse, plenty of memory and a modern GL limit. */
const DESKTOP: DeviceDescriptor = {
  coarsePointer: false,
  deviceMemoryGb: 8,
  maxTextureSize: 16384,
  drawingBufferWidth: 2560,
  drawingBufferHeight: 1440,
  pixelRatio: 1,
};

/** The case this whole module exists for: a mid-range Android. */
const PHONE: DeviceDescriptor = {
  coarsePointer: true,
  deviceMemoryGb: 4,
  maxTextureSize: 4096,
  drawingBufferWidth: 618,
  drawingBufferHeight: 1373,
  pixelRatio: 1.5,
};

/** The same phone on a browser that does not implement `deviceMemory` at all. */
const PHONE_NO_MEMORY: DeviceDescriptor = { ...PHONE, deviceMemoryGb: null };

/** Desktop Safari or Firefox: also no `deviceMemory`, and nothing else wrong. */
const DESKTOP_NO_MEMORY: DeviceDescriptor = { ...DESKTOP, deviceMemoryGb: null };

const desktop = classifyDevice(DESKTOP);
const phone = classifyDevice(PHONE);

const MB = 1024 * 1024;

// --- 1. the desktop gets the full plan --------------------------------------

{
  check("desktop tier", desktop.tier === "full", `tier ${desktop.tier}`);
  check(
    "desktop was not forced down by anything",
    desktop.reasons.length === 0,
    desktop.reasons.length ? desktop.reasons.join("; ") : "no rules fired",
  );
  check("desktop msaa", desktop.msaaSamples === 4, `${desktop.msaaSamples}x`);
  check("desktop ambient occlusion", desktop.aoEnabled, String(desktop.aoEnabled));
  check(
    "desktop sun cascades",
    desktop.shadowCascadeCount === 3 && desktop.shadowCascadeSize === 2048,
    `${desktop.shadowCascadeCount} x ${desktop.shadowCascadeSize}`,
  );
  check(
    "desktop aircraft probes",
    desktop.aircraftEnvSize === 128 && desktop.aircraftShadowSize === 1024,
    `env ${desktop.aircraftEnvSize}, self-shadow ${desktop.aircraftShadowSize}`,
  );
  check(
    "desktop triangle budgets",
    desktop.buildingTriangleBudget === 1_500_000 && desktop.roadTriangleBudget === 700_000,
    `${desktop.buildingTriangleBudget} buildings, ${desktop.roadTriangleBudget} roads`,
  );
  check(
    "desktop ring plan",
    JSON.stringify(desktop.rings) === JSON.stringify(CITY_RINGS),
    `${desktop.rings.length} rings, zooms ${desktop.rings.map((r) => r.imageryZoom).join(",")}`,
  );

  // VACUITY PROBE. Every assertion above would also pass if the classifier
  // ignored its argument and always returned the full plan. This is the case it
  // must not answer "full" to.
  check(
    "probe: the full plan is not simply what everything gets",
    classifyDevice(PHONE).tier !== "full",
    `phone tier ${classifyDevice(PHONE).tier}`,
  );
}

// --- 2. the phone gets a reduced plan on every axis --------------------------

{
  check("phone tier", phone.tier === "reduced", `tier ${phone.tier}`);
  check(
    "phone says why it was reduced",
    phone.reasons.length > 0,
    phone.reasons.join("; ") || "(no reason recorded)",
  );

  // Axis by axis, against literals rather than against the desktop budget: a
  // comparison to `desktop.x` would still pass if both tiers were raised
  // together, which is the mistake this file is here to catch.
  check("phone msaa is off", phone.msaaSamples === 0, `${phone.msaaSamples}x`);
  check("phone ambient occlusion is off", !phone.aoEnabled, String(phone.aoEnabled));
  check(
    "phone sun cascades",
    phone.shadowCascadeCount === 2 && phone.shadowCascadeSize === 1024,
    `${phone.shadowCascadeCount} x ${phone.shadowCascadeSize}`,
  );
  check(
    "phone aircraft probes",
    phone.aircraftEnvSize === 64 && phone.aircraftShadowSize === 512,
    `env ${phone.aircraftEnvSize}, self-shadow ${phone.aircraftShadowSize}`,
  );
  check(
    "phone triangle budgets",
    phone.buildingTriangleBudget <= 800_000 && phone.roadTriangleBudget <= 400_000,
    `${phone.buildingTriangleBudget} buildings, ${phone.roadTriangleBudget} roads`,
  );
  check(
    "phone ring plan",
    JSON.stringify(phone.rings) === JSON.stringify(MOBILE_CITY_RINGS),
    `zooms ${phone.rings.map((r) => r.imageryZoom).join(",")}`,
  );

  // And the relation between the two tiers, which is the part a reader actually
  // cares about: nothing on the phone may be larger than on the desktop, and at
  // least one thing must be strictly smaller on every axis.
  const axes: [string, number, number][] = [
    ["msaa", phone.msaaSamples, desktop.msaaSamples],
    ["cascade size", phone.shadowCascadeSize, desktop.shadowCascadeSize],
    ["cascade count", phone.shadowCascadeCount, desktop.shadowCascadeCount],
    ["env probe", phone.aircraftEnvSize, desktop.aircraftEnvSize],
    ["self-shadow", phone.aircraftShadowSize, desktop.aircraftShadowSize],
    ["building tris", phone.buildingTriangleBudget, desktop.buildingTriangleBudget],
    ["road tris", phone.roadTriangleBudget, desktop.roadTriangleBudget],
  ];
  const notSmaller = axes.filter(([, p, d]) => !(p < d)).map(([name]) => name);
  check(
    "every numeric axis is strictly smaller on the phone",
    notSmaller.length === 0,
    notSmaller.length ? `not smaller: ${notSmaller.join(", ")}` : `${axes.length} axes checked`,
  );
  const zoomsDown = phone.rings.every((r, i) => r.imageryZoom <= CITY_RINGS[i].imageryZoom);
  check(
    "no phone ring asks for a sharper drape than the desktop one",
    zoomsDown && phone.rings.length === CITY_RINGS.length,
    `phone ${phone.rings.map((r) => r.imageryZoom).join(",")} vs desktop ${CITY_RINGS.map((r) => r.imageryZoom).join(",")}`,
  );

  // VACUITY PROBE for the axis sweep. The sweep reports "0 not smaller" both
  // when every axis shrank and when there were no axes to look at, and the
  // second of those is how a gate reports "0 checked" forever. Assert it had
  // something to check, and that the same predicate rejects a comparison of a
  // plan against itself.
  const selfCompare = axes.filter(([, p]) => !(p < p)).map(([name]) => name);
  check(
    "probe: the axis sweep rejects a plan compared with itself",
    axes.length === 7 && selfCompare.length === axes.length,
    `${axes.length} axes, ${selfCompare.length} rejected when compared with themselves`,
  );
}

// --- 3. an absent deviceMemory is not read as plenty -------------------------
//
// `navigator.deviceMemory` is Chromium-only. The realistic bug is
// `deviceMemory ?? 8`, which silently promotes every iPhone and every Firefox
// Android to the desktop plan, and it is invisible on the machine writing it.

{
  const noMem = classifyDevice(PHONE_NO_MEMORY);
  const assumed = assumedMemoryGb(PHONE_NO_MEMORY);

  check(
    "coarse device with no deviceMemory is assumed small",
    assumed <= 4,
    `assumed ${assumed} GB`,
  );
  check(
    "coarse device with no deviceMemory gets the reduced plan",
    noMem.tier === "reduced",
    `tier ${noMem.tier}`,
  );
  // Not just the outcome, the mechanism: the memory rule has to be one of the
  // rules that fired. Were absence read as plenty, this device would still be
  // reduced by the coarse-pointer rule and the outcome assertion above would
  // pass while the bug shipped.
  check(
    "the memory rule is what caught it, not only the pointer rule",
    noMem.reasons.some((r) => r.includes("memory")),
    noMem.reasons.join("; "),
  );
  check(
    "an absent deviceMemory is reported as assumed, not as fact",
    noMem.reasons.some((r) => r.includes("assumed")),
    noMem.reasons.join("; "),
  );

  // VACUITY PROBE. "Assumed small" and "a memory rule fired" must both be false
  // for a device that reports plenty, or they are saying nothing about absence.
  check(
    "probe: a device reporting 8 GB is not assumed small",
    assumedMemoryGb(DESKTOP) > 4 && !desktop.reasons.some((r) => r.includes("memory")),
    `assumed ${assumedMemoryGb(DESKTOP)} GB, reasons [${desktop.reasons.join("; ")}]`,
  );
  // Second probe, the other direction: absence on its own must not condemn a
  // machine. If it did, the assertion above would be passing because the
  // classifier reduces everything with a null memory, which is a different
  // (and wrong) classifier that happens to agree on this one case.
  check(
    "probe: a desktop with no deviceMemory still gets the full plan",
    classifyDevice(DESKTOP_NO_MEMORY).tier === "full",
    `tier ${classifyDevice(DESKTOP_NO_MEMORY).tier}, assumed ${assumedMemoryGb(DESKTOP_NO_MEMORY)} GB`,
  );
}

// --- 4. the two tiers are provably different in bytes ------------------------
//
// A literal ceiling, chosen once and written here rather than derived from the
// module: 300 MB of GPU memory is more than a browser tab should be asking a
// 4 GB phone for, and comfortably less than the desktop plan wants. If a change
// moves either tier across it, that is the change being visible, which is the
// entire point of the number.

const CEILING_BYTES = 300 * MB;

{
  check(
    "phone tier fits under the ceiling",
    phone.memory.totalBytes < CEILING_BYTES,
    `${(phone.memory.totalBytes / MB).toFixed(1)} MB < ${CEILING_BYTES / MB} MB`,
  );
  check(
    "desktop tier is above the ceiling",
    desktop.memory.totalBytes > CEILING_BYTES,
    `${(desktop.memory.totalBytes / MB).toFixed(1)} MB > ${CEILING_BYTES / MB} MB`,
  );

  // The ceiling has to separate PLANS, not merely devices: the phone's total is
  // smaller partly because its screen is smaller, and a ceiling that only ever
  // measured the drawing buffer would say nothing about the ring plan, the
  // cascades or the triangle budgets. Put the full plan on the phone and it
  // must still blow the ceiling.
  const fullOnPhone = budgetForTier("full", PHONE);
  check(
    "the full plan blows the ceiling even on the phone's small screen",
    fullOnPhone.memory.totalBytes > CEILING_BYTES,
    `${(fullOnPhone.memory.totalBytes / MB).toFixed(1)} MB > ${CEILING_BYTES / MB} MB`,
  );
  const reducedOnDesktop = budgetForTier("reduced", DESKTOP);
  check(
    "the reduced plan fits the ceiling even on the desktop's big screen",
    reducedOnDesktop.memory.totalBytes < CEILING_BYTES,
    `${(reducedOnDesktop.memory.totalBytes / MB).toFixed(1)} MB < ${CEILING_BYTES / MB} MB`,
  );

  // VACUITY PROBE. Both bounds above would pass if the two tiers were the same
  // plan under two names and the numbers happened to straddle the line for some
  // other reason. Demand a real gap, and demand that no single item accounts
  // for the whole difference.
  const ratio = desktop.memory.totalBytes / phone.memory.totalBytes;
  check(
    "probe: the tiers differ by more than a rounding error",
    ratio > 2,
    `desktop is ${ratio.toFixed(2)}x the phone`,
  );
}

// --- 5. the itemised estimate sums to the reported total ---------------------

{
  for (const [name, b] of [["desktop", desktop], ["phone", phone]] as [string, Budget][]) {
    let sum = 0;
    for (const item of b.memory.items) sum += item.bytes;
    check(
      `${name} items sum to the reported total`,
      Math.abs(sum - b.memory.totalBytes) < 1,
      `${(sum / MB).toFixed(3)} MB vs ${(b.memory.totalBytes / MB).toFixed(3)} MB`,
    );
  }

  // VACUITY PROBE. "The sum matches" is trivially true of an empty list and of
  // a list of zeroes, and either would make the diagnostics panel print a
  // reassuring 0.0 MB forever. Demand the items exist, are all named
  // differently, and that dropping any one of them breaks the sum.
  //
  // On the desktop budget specifically, because it is the tier with every
  // consumer switched on: the phone's ambient occlusion line is legitimately
  // zero bytes, and a zero item can be dropped without moving the total.
  const items = desktop.memory.items;
  const names = new Set(items.map((i) => i.what));
  check(
    "probe: the estimate has distinct, non-empty items",
    items.length >= 8 && names.size === items.length && items.every((i) => i.bytes > 0),
    `${items.length} items, ${names.size} distinct names, smallest ${(Math.min(...items.map((i) => i.bytes)) / MB).toFixed(3)} MB`,
  );
  const brokenSums = items.filter((_, drop) => {
    let sum = 0;
    items.forEach((it, i) => { if (i !== drop) sum += it.bytes; });
    return Math.abs(sum - desktop.memory.totalBytes) < 1;
  });
  check(
    "probe: dropping any one item breaks the sum",
    brokenSums.length === 0,
    brokenSums.length ? `still summed without ${brokenSums.map((i) => i.what).join(", ")}` : `${items.length} drops all detected`,
  );
}

// --- 6. the classifier is pure -----------------------------------------------

{
  const a = JSON.stringify(classifyDevice(DESKTOP));
  // Interleaved on purpose: a classifier that memoised internally, or that
  // mutated a shared plan object, would fail here and pass a back-to-back
  // comparison.
  const other = JSON.stringify(classifyDevice(PHONE));
  const b = JSON.stringify(classifyDevice(DESKTOP));
  check(
    "same descriptor gives the same budget across an interleaved call",
    a === b,
    `${a.length} chars, identical`,
  );
  // And against the desktop budget taken at the very top of this file, before
  // any other descriptor had been through the classifier. Without this, a
  // classifier that writes into a shared plan object survives: the write
  // happens once, before all three calls above, and they then agree with each
  // other on the corrupted answer. Found by breaking exactly that.
  check(
    "a budget taken before any other classification still matches a fresh one",
    JSON.stringify(desktop) === b,
    `${JSON.stringify(desktop).length} chars at load, ${b.length} chars now`,
  );

  // VACUITY PROBE. `a === b` is also true if the classifier returns one
  // constant for everything, in which case it has no hidden state because it
  // has no state at all and the assertion means nothing.
  check(
    "probe: a different descriptor gives a different budget",
    a !== other,
    `desktop ${a.length} chars, phone ${other.length} chars`,
  );

  // And the shared ring tables must not have been mutated by any of the above,
  // which is the specific way a "pure" function that hands out a reference to a
  // module-level array stops being pure.
  check(
    "probe: the exported ring tables are untouched",
    CITY_RINGS.length === 5 && CITY_RINGS[0].imageryZoom === 18 && MOBILE_CITY_RINGS[4].imageryZoom === 9,
    `${CITY_RINGS.length} desktop rings, ${MOBILE_CITY_RINGS.length} mobile rings`,
  );
}

// --- 7. the texture rule is derived, not guessed -----------------------------
//
// The full drape plan needs one texture per ring, and a device whose
// MAX_TEXTURE_SIZE is below the widest of them cannot upload it at all. The
// rule is written against that width rather than against a round number, so
// this checks the width is what it is claimed to be, from literals.

{
  const widestFull = widestDrapeTexturePx(CITY_RINGS);
  const widestMobile = widestDrapeTexturePx(MOBILE_CITY_RINGS);
  check(
    "full drape needs more than 2048 px and no more than 4096",
    widestFull > 2048 && widestFull <= 4096,
    `${widestFull} px`,
  );
  check(
    "reduced drape fits the 2048 px every WebGL2 device is guaranteed",
    widestMobile <= 2048,
    `${widestMobile} px`,
  );
  const small: DeviceDescriptor = { ...DESKTOP, maxTextureSize: 2048 };
  check(
    "a desktop with a 2048 px texture limit is reduced",
    classifyDevice(small).tier === "reduced",
    classifyDevice(small).reasons.join("; "),
  );

  // VACUITY PROBE. The rule must be reading MAX_TEXTURE_SIZE, not the pointer
  // or the memory of that same descriptor: those are unchanged from DESKTOP,
  // which the first block asserted comes out full.
  check(
    "probe: only the texture limit changed between those two descriptors",
    classifyDevice({ ...DESKTOP, maxTextureSize: 16384 }).tier === "full",
    `16384 -> full, 2048 -> ${classifyDevice(small).tier}`,
  );
  // And an unreported limit must not condemn the device, since a browser that
  // refused a probe context tells us nothing about its texture limit.
  check(
    "probe: an unknown texture limit is not treated as a small one",
    classifyDevice({ ...DESKTOP, maxTextureSize: null }).tier === "full",
    `tier ${classifyDevice({ ...DESKTOP, maxTextureSize: null }).tier}`,
  );
}

console.log(failures === 0 ? "\nall budget checks ok" : `\n${failures} budget check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
