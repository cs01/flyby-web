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
export function foamThreshold(U: number, slopeVar: number, chop = OCEAN_CHOP, share = 1): FoamThreshold {
  const W = whitecapCoverage(U) * share;
  const sd = chop * Math.sqrt(Math.max(slopeVar, 0));
  if (W < 1e-5 || sd <= 1e-6) return { jth: -10, soft: 0.1 };
  return { jth: 1 + sd * invNorm(W), soft: 0.3 * sd };
}

/**
 * The share of the whitecap coverage that is the breaker itself, as against
 * the foam it leaves behind. The GPU keeps foam for seconds after the crest
 * that made it has run on (render/ocean.ts, FOAM_TAU_S), so a threshold set for
 * the whole coverage foamed a quarter of the sea once that history built up:
 * the crests sweep across most of it in a few seconds. With this share the
 * accumulated map averages about the coverage again (test/ocean.check.ts
 * replays the accumulation to hold it there).
 */
export const FOAM_ACTIVE_SHARE = 0.18;

/** Seconds a foam patch takes to fall to 1/e once its crest has passed. */
export const FOAM_TAU_S = 5;

/** Foam from the Jacobian, as the GPU post pass writes it before accumulation. */
export function foamAt(J: number, f: FoamThreshold): number {
  const t = Math.min(1, Math.max(0, (f.jth + f.soft - J) / (2 * f.soft)));
  return t * t * (3 - 2 * t);
}

// --- swell --------------------------------------------------------------------

/**
 * The open-ocean swell: waves from storms far away, not the local wind, so no
 * wind or fetch here can produce them. There is no live swell feed, so this is
 * the Northern California climatology: from the west-northwest, around a 12 s
 * peak, Hs about 3 m offshore. A bay chop rides on it outside a coast and is all there
 * is behind one; swellExposure says which.
 */
export const SWELL_FROM_DEG = 290;
export const SWELL_HS_M = 3.0;
export const SWELL_TP_S = 12;

/** One long-crested swell component, in world axes (x east, z south). */
export interface SwellWave {
  /** Unit direction of travel. */
  dx: number;
  dz: number;
  k: number;
  /** Rounded to the phase clock, as every FFT frequency is. */
  omega: number;
  amp: number;
  phase: number;
}

/** Components in the swell sum; render/oceanglsl.ts sizes its arrays from this. */
export const SWELL_N = 6;

/**
 * The swell as a few long-crested components around the peak, within +-12
 * degrees of the mean direction (a real swell is that narrow after a thousand
 * kilometres of travel; it is the spread and the slightly different periods
 * that make the crests come in sets rather than as a ruled corduroy).
 * Amplitudes are normalised so 4 sqrt(sum a^2 / 2) is exactly hsM.
 */
export function swellWaves(hsM = SWELL_HS_M, tpS = SWELL_TP_S, fromDeg = SWELL_FROM_DEG): SwellWave[] {
  // Period ratio, direction offset (deg), relative energy, phase. Fixed, not
  // random per load: the same sea every session, and every shot.
  const comps: [number, number, number, number][] = [
    [0.86, -9, 0.55, 0.3], [0.93, 6, 0.85, 2.1], [1.0, -2, 1.0, 4.4],
    [1.06, 11, 0.8, 1.2], [1.13, -12, 0.55, 5.6], [1.24, 3, 0.35, 3.3],
  ];
  const eSum = comps.reduce((s, c) => s + c[2], 0);
  // Variance of the sum is sum a^2 / 2 = (hs / 4)^2.
  const varTotal = (hsM / 4) ** 2;
  return comps.map(([pr, dDeg, e, ph]) => {
    const omega = Math.max(OMEGA0, quantisedOmega(((2 * Math.PI) / (tpS * pr)) ** 2 / G));
    const k = (omega * omega) / G;
    // Travelling AWAY from fromDeg: compass bearing fromDeg + 180.
    const b = ((fromDeg + 180 + dDeg) * Math.PI) / 180;
    return {
      dx: Math.sin(b), dz: -Math.cos(b), k, omega,
      amp: Math.sqrt((2 * varTotal * e) / eSum), phase: ph,
    };
  });
}

/** Significant height of a swell sum, 4 sigma. */
export function swellHs(waves: SwellWave[]): number {
  return 4 * Math.sqrt(waves.reduce((s, w) => s + (w.amp * w.amp) / 2, 0));
}

/**
 * How much of the open-ocean swell reaches (x, z), 0..1, from the distance to
 * the nearest land: rays cast back toward where the swell comes from, sphere
 * traced on that distance field (every step can be as long as the distance to
 * shore without crossing land). A ray that runs 30 km of open water has reached
 * the open sea; one that meets a coast inside 6 km is in its lee. 6 km and not
 * less because a bay is that wide: a ray across SF bay runs 8 to 10 km before
 * it meets Marin, and the bay must not read as half open ocean. Seven rays
 * across +-27 degrees, because a swell bends round a headland and spreads
 * through a gap: inside the Golden Gate some of it arrives through the gap even
 * where the straight line upwind lands on the Marin cliffs.
 *
 * shoreAt(x, z) is metres to the nearest land, 0 on land; the grid edge reads
 * as open water (see shoreDistanceM in data/landmask.ts), which is right for
 * a sea that runs off the map.
 */
const RAYS = [-27, -18, -9, 0, 9, 18, 27];

export function swellExposure(shoreAt: (x: number, z: number) => number, x: number, z: number, fromDeg = SWELL_FROM_DEG): number {
  if (shoreAt(x, z) < 20) return 0;
  const OPEN_M = 30000;
  let sum = 0;
  for (const off of RAYS) {
    const b = ((fromDeg + off) * Math.PI) / 180;
    const ux = Math.sin(b);
    const uz = -Math.cos(b);
    let t = 0;
    for (let i = 0; i < 48 && t < OPEN_M; i++) {
      const d = shoreAt(x + ux * t, z + uz * t);
      if (d < 25) break;
      // Never shorter than 2% of the way so far: along a coast parallel to
      // the ray the distance stays small and the march would crawl.
      t += Math.max(d * 0.9, 40, 0.02 * t);
    }
    const open = Math.min(t, OPEN_M);
    const e = Math.min(1, Math.max(0, (open - 6000) / (OPEN_M - 6000)));
    sum += e * e * (3 - 2 * e);
  }
  return sum / RAYS.length;
}

/**
 * Metres to land from the two sqrt-encoded R8 shore grids the GPU samples, the
 * same bilinear read and near/far crossfade as the terrain shader's, for code
 * that needs the field on the CPU. See encodeShoreDistance in data/landmask.ts.
 */
export function shoreSampler(
  near: { data: Uint8Array; n: number; extentM: number; maxM: number },
  far: { data: Uint8Array; n: number; extentM: number; maxM: number },
): (x: number, z: number) => number {
  const read = (g: typeof near, x: number, z: number): number => {
    // Texel centres at (i + 0.5) / n, clamped to the edge like the GPU's.
    const fx = Math.min(g.n - 1, Math.max(0, ((x / (2 * g.extentM)) + 0.5) * g.n - 0.5));
    const fz = Math.min(g.n - 1, Math.max(0, ((z / (2 * g.extentM)) + 0.5) * g.n - 0.5));
    const i = Math.min(g.n - 2, Math.floor(fx));
    const k = Math.min(g.n - 2, Math.floor(fz));
    const ax = fx - i;
    const az = fz - k;
    const at = (a: number, b: number): number => g.data[b * g.n + a] / 255;
    const v = (at(i, k) * (1 - ax) + at(i + 1, k) * ax) * (1 - az) + (at(i, k + 1) * (1 - ax) + at(i + 1, k + 1) * ax) * az;
    return v * v * g.maxM;
  };
  return (x, z) => {
    const r = Math.max(Math.abs(x), Math.abs(z)) / Math.max(1, near.extentM);
    const w = Math.min(1, Math.max(0, (r - 0.9) / 0.1));
    const s = w * w * (3 - 2 * w);
    return s >= 1 ? read(far, x, z) : s <= 0 ? read(near, x, z) : read(near, x, z) * (1 - s) + read(far, x, z) * s;
  };
}
