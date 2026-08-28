// Ear-clipping triangulation for simple polygons.
//
// Building roofs need triangles and OSM footprints are arbitrary simple
// polygons, often concave (courtyards excepted -- those come through as
// separate outer rings). Ear clipping is O(n^2) worst case, which sounds bad
// until you notice n is about 10: a typical footprint is a rectangle with a
// couple of notches, and the whole city triangulates in a few milliseconds.
//
// The guard that matters is the degenerate-input one. A ring with a repeated
// vertex or zero area makes the naive loop spin forever, and a hang at load
// with no error is far worse than a missing roof.

/**
 * Triangulate a ring given as flat [x0,z0, x1,z1, ...], counter-clockwise.
 * Returns indices into the ring's vertex numbering.
 */
export function triangulate(ring: Float32Array): Uint32Array {
  const n = ring.length / 2;
  if (n < 3) return new Uint32Array(0);
  if (n === 3) return new Uint32Array([0, 1, 2]);

  const idx: number[] = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;

  const out: number[] = [];
  // Every successful clip removes one vertex, so n-2 clips finish the job. The
  // budget bounds the pathological case where no ear is ever found (a
  // self-intersecting ring), which does happen in OSM data.
  let guard = n * n;

  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];

      const ax = ring[ia * 2], az = ring[ia * 2 + 1];
      const bx = ring[ib * 2], bz = ring[ib * 2 + 1];
      const cx = ring[ic * 2], cz = ring[ic * 2 + 1];

      // Convex corner test, for a counter-clockwise ring in (x, z).
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (cross <= 0) continue;

      // No other vertex may lie inside the candidate ear.
      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const ip = idx[j];
        if (ip === ia || ip === ib || ip === ic) continue;
        const px = ring[ip * 2], pz = ring[ip * 2 + 1];
        const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
        const d2 = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx);
        const d3 = (ax - cx) * (pz - cz) - (az - cz) * (px - cx);
        if (d1 >= 0 && d2 >= 0 && d3 >= 0) { contains = true; break; }
      }
      if (contains) continue;

      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    // No ear found: the ring is self-intersecting or degenerate. Fan it and
    // move on -- a slightly wrong roof beats an infinite loop.
    if (!clipped) break;
  }

  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  return new Uint32Array(out);
}

/** Signed area in the (x, z) plane. Positive is counter-clockwise. */
export function signedArea(ring: Float32Array): number {
  const n = ring.length / 2;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (ring[j * 2] - ring[i * 2]) * (ring[j * 2 + 1] + ring[i * 2 + 1]);
  }
  return a / 2;
}
