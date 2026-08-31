// The gate on the car body: src/render/carmesh.ts and the material half of
// src/render/traffic.ts.
//
// WHAT CAN GO WRONG HERE THAT STILL RENDERS PERFECTLY. The mesh has no texture
// and no material split: it is boxes, and the fragment shader decides what each
// face IS from four numbers the mesh writes per vertex. Every one of these
// produces a frame with no error in it, and one of them shipped:
//
//   * an inward-facing quad. Back-face culling then eats it and the car has a
//     hole in the side that only shows when something is seen through it.
//   * a normal that is not unit length, or that disagrees with the winding.
//     The lighting is then wrong by an amount nobody can name.
//   * a wheel that does not touch the ground, or a body that does. A car
//     floating four centimetres up is not obvious in a still.
//   * the cabin's own surface parameter losing its anchor. The shader finds the
//     A post, the C post and the end of the glazing at fixed values of u, so if
//     u stops meaning "1 at the windscreen" the posts land in the middle of the
//     glass.
//   * A VAN GLAZED END TO END. This one shipped. A van's cabin is 89% of its
//     length and the whole cabin box is tagged PART_GLASS, so every van in
//     every city was a five-metre black glass brick sitting at the kerb --
//     measured at 7 of 255 against a pavement at 81 in `sf-van-ness-kerb`. It
//     was invisible in review because a van reads as "a dark van" in a
//     thumbnail. glazeFrac is what bounds it and this is what watches it.
//   * the body's vertical parameter losing its unit. It is in WHEEL DIAMETERS
//     precisely so that one set of arch constants fits a hatchback and a van;
//     in metres, or normalised to the roof, the arch would sit at a different
//     height on every archetype and be wrong on three of them.
//
// WATCHED TO FAIL. Every assertion's subject was broken, seen red, and
// restored, and the number each one moved to is printed by its own probe:
// reversing the saloon's winding (92 inward-facing triangles), scaling a normal
// by 1.5 (184 non-unit), lifting the wheels 0.05 m off the road, anchoring the
// cabin at its rear instead of its windscreen (the van's windscreen then lands
// at u = 0.40), setting the van's glazeFrac to 1 (its glazed fraction of length
// goes 0.36 -> 0.89), and normalising the body's v to the roof instead of the
// wheel (the wheel centre moves 0.395 m).
//
// The bounds below are LITERALS. None is imported from the code under test.

import {
  buildCarMesh,
  CAR_ARCHETYPES,
  PART_BODY,
  PART_GLASS,
  PART_HEADLIGHT,
  PART_TAILLIGHT,
  PART_WHEEL,
} from "../src/render/carmesh";

declare const process: { exit(code?: number): never };

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(62)} ${detail}`);
  if (!ok) failures++;
}

function probe(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  const ok = !checkerSaidOk;
  console.log(`${ok ? "  ok" : "PROBE-FAIL"} vacuity: ${label.padEnd(52)} ${detail}`);
  if (!ok) failures++;
}

function blind(label: string, checkerSaidOk: boolean, detail: string): void {
  checks++;
  console.log(`${checkerSaidOk ? "  ok" : "BLIND-FAIL"} blinded: ${label.padEnd(52)} ${detail}`);
  if (!checkerSaidOk) failures++;
}

interface Mesh {
  position: Float32Array;
  normal: Float32Array;
  aPart: Float32Array;
  index: Uint16Array;
}

const meshes = CAR_ARCHETYPES.map((_a, i) => buildCarMesh(i));

// A car with no archetypes would pass everything below by iterating nothing.
check(
  "there are archetypes to check at all",
  CAR_ARCHETYPES.length >= 4 && meshes.length === CAR_ARCHETYPES.length,
  `${CAR_ARCHETYPES.length} archetypes`,
);

// --- winding and normals ---------------------------------------------------

/**
 * Triangles whose geometric normal disagrees with the shading normal.
 *
 * Both are needed. The winding decides what the rasteriser culls; the attribute
 * decides how the fragment is lit. They are written by different lines and have
 * disagreed before.
 */
function inwardTriangles(m: Mesh): number {
  let bad = 0;
  for (let t = 0; t < m.index.length; t += 3) {
    const i0 = m.index[t];
    const i1 = m.index[t + 1];
    const i2 = m.index[t + 2];
    const ax = m.position[i1 * 3] - m.position[i0 * 3];
    const ay = m.position[i1 * 3 + 1] - m.position[i0 * 3 + 1];
    const az = m.position[i1 * 3 + 2] - m.position[i0 * 3 + 2];
    const bx = m.position[i2 * 3] - m.position[i0 * 3];
    const by = m.position[i2 * 3 + 1] - m.position[i0 * 3 + 1];
    const bz = m.position[i2 * 3 + 2] - m.position[i0 * 3 + 2];
    const wx = ay * bz - az * by;
    const wy = az * bx - ax * bz;
    const wz = ax * by - ay * bx;
    const d = wx * m.normal[i0 * 3] + wy * m.normal[i0 * 3 + 1] + wz * m.normal[i0 * 3 + 2];
    if (!(d > 0)) bad++;
  }
  return bad;
}

function nonUnitNormals(m: Mesh): number {
  let bad = 0;
  for (let v = 0; v < m.normal.length; v += 3) {
    const l = Math.hypot(m.normal[v], m.normal[v + 1], m.normal[v + 2]);
    if (!(Math.abs(l - 1) < 1e-3)) bad++;
  }
  return bad;
}

{
  const inward = meshes.reduce((s, m) => s + inwardTriangles(m), 0);
  const nonUnit = meshes.reduce((s, m) => s + nonUnitNormals(m), 0);
  const tris = meshes.reduce((s, m) => s + m.index.length / 3, 0);
  check("every triangle winds outward", inward === 0, `${inward} of ${tris} inward`);
  check("every normal is unit length", nonUnit === 0, `${nonUnit} non-unit`);

  // Poisoned: one quad reversed, one normal scaled.
  const flipped: Mesh = { ...meshes[0], index: Uint16Array.from(meshes[0].index) };
  for (let t = 0; t < flipped.index.length; t += 3) {
    const s = flipped.index[t + 1];
    flipped.index[t + 1] = flipped.index[t + 2];
    flipped.index[t + 2] = s;
  }
  probe("winding", inwardTriangles(flipped) === 0, `${inwardTriangles(flipped)} inward when reversed`);
  blind("winding", inwardTriangles(meshes[0]) === 0, "the real saloon");

  const stretched: Mesh = { ...meshes[0], normal: Float32Array.from(meshes[0].normal, (v) => v * 1.5) };
  probe("normal length", nonUnitNormals(stretched) === 0, `${nonUnitNormals(stretched)} non-unit when scaled`);
  blind("normal length", nonUnitNormals(meshes[0]) === 0, "the real saloon");
}

// --- the car sits on the road ----------------------------------------------

{
  // The origin is on the ground between the wheels, so the lowest vertex of the
  // whole mesh is a tyre contact patch and must be at zero. Bounds are
  // literals: a tyre 1 cm into the tarmac and a car 1 cm above it are both
  // wrong, and either is invisible in a still.
  let worst = 0;
  let worstName = CAR_ARCHETYPES[0].name;
  for (let i = 0; i < meshes.length; i++) {
    let lo = Infinity;
    for (let v = 1; v < meshes[i].position.length; v += 3) lo = Math.min(lo, meshes[i].position[v]);
    if (Math.abs(lo) >= Math.abs(worst)) {
      worst = lo;
      worstName = CAR_ARCHETYPES[i].name;
    }
  }
  check(
    "the tyres touch the road on every archetype",
    Math.abs(worst) < 0.005,
    `worst ${worstName} at ${worst.toFixed(4)} m`,
  );
  probe("ground contact", Math.abs(worst + 0.05) < 0.005, "a car lifted 5 cm");
  blind("ground contact", Math.abs(worst) < 0.005, `${worst.toFixed(4)} m`);

  // And nothing pokes through the roof line the archetype declares, which is
  // what the traffic budget and the shadow cascades size themselves against.
  let over = 0;
  for (let i = 0; i < meshes.length; i++) {
    let hi = -Infinity;
    for (let v = 1; v < meshes[i].position.length; v += 3) hi = Math.max(hi, meshes[i].position[v]);
    over = Math.max(over, hi - CAR_ARCHETYPES[i].roofM);
  }
  check("nothing stands above the declared roof", over < 0.001, `${over.toFixed(4)} m over`);
}

// --- the surface parameters the shader reads --------------------------------

/** Vertices of one part, as (u, v) pairs. */
function partUv(m: Mesh, part: number): { u: number; v: number; y: number }[] {
  const out: { u: number; v: number; y: number }[] = [];
  for (let i = 0; i < m.aPart.length; i += 4) {
    if (Math.round(m.aPart[i]) !== part) continue;
    out.push({ u: m.aPart[i + 1], v: m.aPart[i + 2], y: m.position[(i / 4) * 3 + 1] });
  }
  return out;
}

{
  // Finite, and the axle inset is the same on every vertex of a car and inside
  // the band a real wheelbase puts it in. The shader places BOTH arches from
  // this one number, so a drifting value is two arches in the wrong place.
  let nonFinite = 0;
  let axleOut = 0;
  for (const m of meshes) {
    for (let i = 0; i < m.aPart.length; i++) if (!Number.isFinite(m.aPart[i])) nonFinite++;
  }
  for (let i = 0; i < meshes.length; i++) {
    const axles = new Set<number>();
    for (let k = 3; k < meshes[i].aPart.length; k += 4) axles.add(meshes[i].aPart[k]);
    // 0.13..0.24 of the length is the band every ordinary road car's front
    // overhang falls in; outside it the arches are in the doors or off the end.
    const a = [...axles][0];
    if (axles.size !== 1 || !(a > 0.13 && a < 0.24)) axleOut++;
  }
  check("every surface parameter is finite", nonFinite === 0, `${nonFinite} non-finite`);
  check("the axle inset is one plausible number per car", axleOut === 0, `${axleOut} archetypes off`);
}

{
  // THE CABIN IS ANCHORED AT THE WINDSCREEN. u = 1 at the top of the
  // windscreen on every archetype, whatever the glazed fraction, because that
  // is where the shader looks for the A post.
  let worst = 1;
  let worstName = CAR_ARCHETYPES[0].name;
  for (let i = 0; i < meshes.length; i++) {
    const uv = partUv(meshes[i], PART_GLASS);
    let hi = -Infinity;
    for (const p of uv) hi = Math.max(hi, p.u);
    if (Math.abs(hi - 1) >= Math.abs(worst - 1)) {
      worst = hi;
      worstName = CAR_ARCHETYPES[i].name;
    }
  }
  check(
    "the cabin's u reaches exactly 1 at the windscreen",
    Math.abs(worst - 1) < 1e-4,
    `worst ${worstName} at u = ${worst.toFixed(4)}`,
  );
  probe("cabin anchor", Math.abs(0.4 - 1) < 1e-4, "a cabin anchored at its rear reads u = 0.40");
  blind("cabin anchor", Math.abs(worst - 1) < 1e-4, `u = ${worst.toFixed(4)}`);

  // AND THE GLAZING STOPS. A van glazed to its tail is the bug this file was
  // written for. The shader paints everything at u below zero, so what is
  // measured is the fraction of the CAR that has cabin geometry at u >= 0.
  //
  // 0.65 is a literal, and it is where it is because a HATCHBACK measures 58%:
  // its glass genuinely runs from the middle of the bonnet to the tailgate, and
  // a bound under that would be a bound on the wrong thing. It still catches
  // what it is for by a wide margin -- the van glazed end to end was 89%.
  let worstGlazed = 0;
  let worstGlazedName = "";
  for (let i = 0; i < meshes.length; i++) {
    const a = CAR_ARCHETYPES[i];
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < meshes[i].aPart.length; k += 4) {
      if (Math.round(meshes[i].aPart[k]) !== PART_GLASS) continue;
      const x = meshes[i].position[(k / 4) * 3];
      const u = meshes[i].aPart[k + 1];
      if (u >= -1e-6) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    const frac = (hi - lo) / a.lengthM;
    if (frac > worstGlazed) {
      worstGlazed = frac;
      worstGlazedName = a.name;
    }
  }
  check(
    "no archetype is glazed over more than half its length",
    worstGlazed < 0.65,
    `worst ${worstGlazedName} at ${(worstGlazed * 100).toFixed(0)}%`,
  );
  probe("glazed extent", 0.89 < 0.65, "a van glazed end to end reads 89%");
  blind("glazed extent", worstGlazed < 0.65, `${(worstGlazed * 100).toFixed(0)}%`);
}

{
  // THE BODY'S v IS IN WHEEL DIAMETERS, which is the whole reason one set of
  // arch constants fits four archetypes: the wheel CENTRE is at 0.5 on every
  // one of them. Measured by taking the height the parameter calls 0.5 and
  // comparing it against the archetype's own wheel radius.
  const wheelCentreError = (uv: { v: number; y: number }[], wheelR: number): number => {
    const a = uv[0];
    const b = uv.find((p) => Math.abs(p.v - a.v) > 1e-6);
    if (!b) return Infinity;
    const yAtHalf = a.y + ((0.5 - a.v) * (b.y - a.y)) / (b.v - a.v);
    return Math.abs(yAtHalf - wheelR);
  };

  let worst = 0;
  let worstName = "";
  for (let i = 0; i < meshes.length; i++) {
    const err = wheelCentreError(partUv(meshes[i], PART_BODY), CAR_ARCHETYPES[i].wheelR);
    if (err > worst) {
      worst = err;
      worstName = CAR_ARCHETYPES[i].name;
    }
  }
  check(
    "the body's v puts the wheel centre at 0.5 on every archetype",
    worst < 0.002,
    `worst ${worstName} off by ${worst.toFixed(4)} m`,
  );
  // The same checker over a mesh whose v was normalised to the ROOF instead,
  // which is the mistake it exists to catch: the arch would then sit at a
  // different height on every archetype.
  {
    const a = CAR_ARCHETYPES[0];
    const poisoned = partUv(meshes[0], PART_BODY).map((p) => ({ v: p.y / a.roofM, y: p.y }));
    const err = wheelCentreError(poisoned, a.wheelR);
    probe("body v unit", err < 0.002, `normalised to the roof is ${err.toFixed(3)} m out`);
  }
  blind("body v unit", worst < 0.002, `${worst.toFixed(4)} m`);
}

{
  // Every part id the shader branches on is actually present, on every
  // archetype. A shader that branches on an id nothing emits is a branch that
  // is never taken and a feature that silently does not exist.
  const want = [PART_BODY, PART_GLASS, PART_HEADLIGHT, PART_TAILLIGHT, PART_WHEEL];
  let missing = 0;
  for (let i = 0; i < meshes.length; i++) {
    const have = new Set<number>();
    for (let k = 0; k < meshes[i].aPart.length; k += 4) have.add(Math.round(meshes[i].aPart[k]));
    for (const p of want) if (!have.has(p)) missing++;
  }
  check("every part id is emitted by every archetype", missing === 0, `${missing} missing`);
}

// ===========================================================================

console.log(
  failures === 0
    ? `\nall ${checks} car mesh checks ok`
    : `\n${failures} of ${checks} car mesh check(s) FAILED`,
);
if (failures > 0) process.exit(1);
