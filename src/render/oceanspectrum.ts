// The ocean's spectrum, and a CPU copy of the GPU FFT, with no three.js and no
// DOM in it so test/ocean.check.ts can run every number the GPU path depends on
// under Bun.
//
// Two jobs. The first is the initial spectrum h0(k) the GPU evolves each frame
// (render/ocean.ts uploads it; nothing per-frame happens here). The second is a
// line-for-line mirror of the GPU passes (time evolution, the Stockham FFT
// pass, the finite-difference Jacobian and the foam threshold), because GLSL
// cannot be unit-tested and an FFT with one index off still draws something
// that looks like water.

export const G = 9.81;

/**
 * The phase clock period, seconds. Every frequency is rounded to a multiple of
 * 2 pi / T so the sea repeats exactly every T seconds, which lets the GPU take
 * the clock mod T: sin(omega t) at an hour into a flight has an argument in the
 * tens of thousands and a phone's sin loses the phase there. At 256 s the
 * rounding moves the longest wave (240 m, omega 0.5) by under 2.5%.
 */
export const PHASE_PERIOD_S = 256;
const OMEGA0 = (2 * Math.PI) / PHASE_PERIOD_S;

/**
 * The fetch the GPU spectrum is built for, metres. One spectrum serves the
 * whole disc, so it is built for the middle of a bay (where the terrain's
 * fetch estimate, four times the distance to the nearest coast plus 200 m,
 * reads about this), and the shader scales its amplitude by the LOCAL fetch
 * (see oceanFetchAmp in render/oceanglsl.ts): a harbour arm gets the same
 * waves, smaller, and open ocean the same, larger. At 20 km mid-bay came out
 * at half height, a millpond with the wind at Beaufort 6.
 */
export const OCEAN_FETCH_REF_M = 6000;

/** Horizontal displacement gain. Above ~1.3 the steepest crests fold over. */
export const OCEAN_CHOP = 1.3;

/** One FFT cascade: a periodic square patch of sea, n texels a side. */
export interface OceanCascadePlan {
  patchM: number;
  n: number;
}

/** The wavelength band one cascade is responsible for, metres. */
export interface OceanBand {
  lamLo: number;
  lamHi: number;
}

/**
 * Split the wavelengths between cascades so no wave is in two of them (which
 * would double its energy). Largest patch first. Each cascade keeps waves of
 * at least 8 of its own texels except the last, which goes down to 4: below 8
 * texels a finer cascade exists to carry them, and the finest has nowhere to
 * hand them, so it keeps them to just above Nyquist.
 */
export function cascadeBands(plan: OceanCascadePlan[]): OceanBand[] {
  const bands: OceanBand[] = [];
  let hi = Infinity;
  for (let i = 0; i < plan.length; i++) {
    const texel = plan[i].patchM / plan[i].n;
    const lo = (i === plan.length - 1 ? 4 : 8) * texel;
    bands.push({ lamLo: lo, lamHi: Math.min(hi, plan[i].patchM) });
    hi = lo;
  }
  return bands;
}

/**
 * Peak angular frequency: JONSWAP's fetch-limited peak, capped at
 * Pierson-Moskowitz's fully developed one. The same formula the terrain water
 * uses, so the near FFT sea and the far analytic one peak at the same place.
 */
export function peakOmega(U: number, fetchM: number): number {
  const u = Math.max(U, 0.5);
  return Math.max(22 * Math.pow((G * G) / (u * fetchM), 1 / 3), (0.877 * G) / u);
}

/** JONSWAP's Phillips constant, which grows as the fetch shortens. */
export function jonswapAlpha(U: number, fetchM: number): number {
  const u = Math.max(U, 0.5);
  return Math.min(0.05, Math.max(0.0081, 0.076 * Math.pow((u * u) / (fetchM * G), 0.22)));
}

/** Omnidirectional elevation spectrum in wavenumber, m^3. */
export function spectrumK(k: number, U: number, fetchM: number): number {
  if (k <= 0) return 0;
  const w = Math.sqrt(G * k);
  const wp = peakOmega(U, fetchM);
  const alpha = jonswapAlpha(U, fetchM);
  const sigma = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  const sw = ((alpha * G * G) / w ** 5) * Math.exp(-1.25 * (wp / w) ** 4) * Math.pow(3.3, r);
  // dw/dk = g / (2 w).
  return (sw * G) / (2 * w);
}

/** Lanczos log-gamma, for the spreading function's normalisation. */
function lgamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Mitsuyasu's spreading exponent: narrowest at the peak, broader both above
 * it (the chop, which is what makes the near field read as crossing seas
 * rather than corduroy) and below it.
 */
function spreadS(w: number, wp: number): number {
  const x = w / wp;
  return Math.max(0.6, x < 1 ? 6.97 * Math.pow(x, 4.06) : 9.77 * Math.pow(x, -2.5));
}

/** cos^2s(theta/2), normalised to integrate to 1 over the circle. */
function spread(theta: number, s: number): number {
  const norm = Math.exp(lgamma(s + 1) - lgamma(s + 0.5)) / (2 * Math.sqrt(Math.PI));
  return norm * Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
}

/** Directional spectrum F(kx, kz), m^4, for a wind blowing along unit (wx, wz). */
export function spectrum2D(kx: number, kz: number, U: number, wx: number, wz: number, fetchM: number): number {
  const k = Math.hypot(kx, kz);
  if (k <= 0) return 0;
  const theta = Math.atan2(kz, kx) - Math.atan2(wz, wx);
  const s = spreadS(Math.sqrt(G * k), peakOmega(U, fetchM));
  return (spectrumK(k, U, fetchM) * spread(theta, s)) / k;
}

/** Signed frequency of FFT index i in standard order. */
export function freqIndex(i: number, n: number): number {
  return i < n / 2 ? i : i - n;
}

/** Whether wavenumber k belongs to this band. */
function inBand(k: number, band: OceanBand): boolean {
  const lam = (2 * Math.PI) / k;
  return lam >= band.lamLo && lam < band.lamHi;
}

export interface CascadeStats {
  /** Expected elevation variance, m^2. */
  heightVar: number;
  /** Expected slope variance (also the variance of the Jacobian's linear term over the chop). */
  slopeVar: number;
}

/** Expected variances over exactly the grid modes the cascade carries. */
export function cascadeStats(c: OceanCascadePlan, band: OceanBand, U: number, wx: number, wz: number, fetchM = OCEAN_FETCH_REF_M): CascadeStats {
  const dk = (2 * Math.PI) / c.patchM;
  let hv = 0;
  let sv = 0;
  for (let y = 0; y < c.n; y++) {
    for (let x = 0; x < c.n; x++) {
      const kx = freqIndex(x, c.n) * dk;
      const kz = freqIndex(y, c.n) * dk;
      const k = Math.hypot(kx, kz);
      if (k === 0 || !inBand(k, band)) continue;
      const e = spectrum2D(kx, kz, U, wx, wz, fetchM) * dk * dk;
      hv += e;
      sv += e * k * k;
    }
  }
  return { heightVar: hv, slopeVar: sv };
}

/**
 * Two unit Gaussians per texel, FIXED per cascade. Fixed so that a change of
 * wind rescales and re-steers the same sea instead of drawing a new one, which
 * would visibly reshuffle every wave each time the weather updates.
 */
export function cascadeGaussians(n: number, seed: number): Float32Array {
  let a = seed | 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  const out = new Float32Array(n * n * 2);
  for (let i = 0; i < out.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rnd()));
    const th = 2 * Math.PI * rnd();
    out[i] = r * Math.cos(th);
    out[i + 1] = r * Math.sin(th);
  }
  return out;
}

/**
 * The initial spectrum for one cascade, written as RGBA into `out` at column
 * offset `x0` of a texture `stride` texels wide: (h0(k), conj(h0(-k))).
 *
 * Normalised so the elevation is a plain unnormalised inverse DFT, eta(x) =
 * sum H(k) e^{ikx}, whose mean square is sum |H|^2 = sum F dk^2 in
 * expectation. H = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}, so |h0|^2 is half that.
 */
export function writeH0(
  c: OceanCascadePlan, band: OceanBand, gauss: Float32Array,
  U: number, wx: number, wz: number, fetchM: number,
  out: Float32Array, x0: number, stride: number,
): void {
  const n = c.n;
  const dk = (2 * Math.PI) / c.patchM;
  const amp = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const kx = freqIndex(x, n) * dk;
      const kz = freqIndex(y, n) * dk;
      const k = Math.hypot(kx, kz);
      amp[y * n + x] = k === 0 || !inBand(k, band) ? 0 : Math.sqrt(spectrum2D(kx, kz, U, wx, wz, fetchM)) * dk * 0.5;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // -k in standard order is (n - x) mod n.
      const j = ((n - y) % n) * n + ((n - x) % n);
      const o = (y * stride + x0 + x) * 4;
      out[o] = gauss[i * 2] * amp[i];
      out[o + 1] = gauss[i * 2 + 1] * amp[i];
      out[o + 2] = gauss[j * 2] * amp[j];
      out[o + 3] = -gauss[j * 2 + 1] * amp[j];
    }
  }
}

/** Frequency rounded to the phase clock; mirrored by the GPU spectrum pass. */
export function quantisedOmega(k: number): number {
  return Math.round(Math.sqrt(G * k) / OMEGA0) * OMEGA0;
}

/**
 * One Stockham radix-2 pass of an inverse DFT over complex interleaved data:
 * output o gathers inputs i and i + n/2. This is the GPU pass verbatim
 * (OCEAN_FFT_FRAG in render/ocean.ts); test/ocean.check.ts proves a run of
 * them equals a direct DFT, which is the only way to know the GLSL is right.
 */
export function stockhamPass(src: Float64Array, dst: Float64Array, n: number, p: number): void {
  for (let o = 0; o < n; o++) {
    const k = o & (p - 1);
    const q = Math.floor(o / (2 * p));
    const diff = (o & p) !== 0;
    const i = q * p + k;
    const ang = (Math.PI * k) / p;
    const tr = Math.cos(ang);
    const ti = Math.sin(ang);
    const ar = src[2 * i];
    const ai = src[2 * i + 1];
    const br = src[2 * (i + n / 2)];
    const bi = src[2 * (i + n / 2) + 1];
    const xr = tr * br - ti * bi;
    const xi = tr * bi + ti * br;
    dst[2 * o] = diff ? ar - xr : ar + xr;
    dst[2 * o + 1] = diff ? ai - xi : ai + xi;
  }
}

/** Unnormalised inverse DFT by log2(n) Stockham passes. */
export function ifft(data: Float64Array, n: number): Float64Array {
  let a: Float64Array = data;
  let b: Float64Array = new Float64Array(2 * n);
  for (let p = 1; p < n; p *= 2) {
    stockhamPass(a, b, n, p);
    const t = a; a = b; b = t;
  }
  return a;
}

/** 2D inverse DFT in place over an n x n complex interleaved grid, rows then columns. */
export function ifft2(re: Float64Array, im: Float64Array, n: number): void {
  const line = new Float64Array(2 * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { line[2 * x] = re[y * n + x]; line[2 * x + 1] = im[y * n + x]; }
    const r = ifft(line.slice(), n);
    for (let x = 0; x < n; x++) { re[y * n + x] = r[2 * x]; im[y * n + x] = r[2 * x + 1]; }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { line[2 * y] = re[y * n + x]; line[2 * y + 1] = im[y * n + x]; }
    const r = ifft(line.slice(), n);
    for (let y = 0; y < n; y++) { re[y * n + x] = r[2 * y]; im[y * n + x] = r[2 * y + 1]; }
  }
}

export interface DisplacementField {
  n: number;
  patchM: number;
  dx: Float32Array;
  dy: Float32Array;
  dz: Float32Array;
}

/**
 * The displacement one cascade's h0 produces at time t, by the same steps the
 * GPU takes: evolve, pack (Dx + i Dz, Dy) into two complex fields, inverse
 * FFT, then scale the horizontal pair by the chop.
 */
export function simulateCascade(c: OceanCascadePlan, h0: Float32Array, x0: number, stride: number, t: number, chop = OCEAN_CHOP): DisplacementField {
  const n = c.n;
  const dk = (2 * Math.PI) / c.patchM;
  const aRe = new Float64Array(n * n);
  const aIm = new Float64Array(n * n);
  const bRe = new Float64Array(n * n);
  const bIm = new Float64Array(n * n);
  const tm = t % PHASE_PERIOD_S;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const kx = freqIndex(x, n) * dk;
      const kz = freqIndex(y, n) * dk;
      const k = Math.hypot(kx, kz);
      const o = (y * stride + x0 + x) * 4;
      const w = quantisedOmega(k) * tm;
      const er = Math.cos(w);
      const ei = Math.sin(w);
      const hr = h0[o] * er - h0[o + 1] * ei + h0[o + 2] * er + h0[o + 3] * ei;
      const hi = h0[o] * ei + h0[o + 1] * er - h0[o + 2] * ei + h0[o + 3] * er;
      const i = y * n + x;
      bRe[i] = hr;
      bIm[i] = hi;
      // H (i kx - kz) / k: the spectra of Dx and Dz, packed as Dx + i Dz.
      if (k > 0) {
        aRe[i] = (-hr * kz - hi * kx) / k;
        aIm[i] = (hr * kx - hi * kz) / k;
      }
    }
  }
  ifft2(aRe, aIm, n);
  ifft2(bRe, bIm, n);
  const dx = new Float32Array(n * n);
  const dy = new Float32Array(n * n);
  const dz = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    dx[i] = chop * aRe[i];
    dz[i] = chop * aIm[i];
    dy[i] = bRe[i];
  }
  return { n, patchM: c.patchM, dx, dy, dz };
}

/** The Jacobian of the horizontal map by central differences, as the GPU post pass takes it. */
export function jacobianField(f: DisplacementField): Float32Array {
  const { n, dx, dz } = f;
  const h2 = (2 * f.patchM) / n;
  const at = (a: Float32Array, x: number, y: number): number => a[((y + n) % n) * n + ((x + n) % n)];
  const J = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const jxx = 1 + (at(dx, x + 1, y) - at(dx, x - 1, y)) / h2;
      const jzz = 1 + (at(dz, x, y + 1) - at(dz, x, y - 1)) / h2;
      const jxz = (at(dx, x, y + 1) - at(dx, x, y - 1)) / h2;
      const jzx = (at(dz, x + 1, y) - at(dz, x - 1, y)) / h2;
      J[y * n + x] = jxx * jzz - jxz * jzx;
    }
  }
  return J;
}

/**
 * Whitecap coverage target: Monahan's W = 3.84e-6 U^3.41, tripled for the
 * residual foam a breaker leaves, capped at 30%. The terrain water uses the
 * same figure for its far field.
 */
export function whitecapCoverage(U: number): number {
  return Math.min(0.3, 3 * 3.84e-6 * Math.pow(Math.max(U, 0), 3.41));
}

/** Acklam's inverse normal CDF. */
function invNorm(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -invNorm(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface FoamThreshold {
  /** The Jacobian below which the surface is foam. */
  jth: number;
  /** Half-width of the soft step there, in Jacobian units. */
  soft: number;
}

/**
 * The Jacobian below which the surface is foam, chosen so the area below it
 * is the whitecap coverage for this wind. J - 1 is, to first order, the chop
 * times the divergence of the horizontal displacement, whose variance is the
 * slope variance, so it is Gaussian with sd chop * sqrt(slopeVar) and the
 * threshold is a quantile. Picking it this way rather than fixing it (0.3 is
 * the usual constant) is what keeps the foam right across winds: a fixed one
 * foams nothing below a gale on a fetch-limited bay and everything above it.
 *
 * The soft edge scales with the same sd. A fixed one was wider than the whole
 * distribution when a cascade held only the calm tail below the peak (the
 * 240 m cascade in a 4 m/s breeze), and foamed a third of the sea.
 */
export function foamThreshold(U: number, slopeVar: number, chop = OCEAN_CHOP): FoamThreshold {
  const W = whitecapCoverage(U);
  const sd = chop * Math.sqrt(Math.max(slopeVar, 0));
  if (W < 1e-5 || sd <= 1e-6) return { jth: -10, soft: 0.1 };
  return { jth: 1 + sd * invNorm(W), soft: 0.3 * sd };
}

/** Foam from the Jacobian, as the GPU post pass writes it before accumulation. */
export function foamAt(J: number, f: FoamThreshold): number {
  const t = Math.min(1, Math.max(0, (f.jth + f.soft - J) / (2 * f.soft)));
  return t * t * (3 - 2 * t);
}
