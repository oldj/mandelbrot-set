import { add, extended, fromFixed, linear, logDifference, logMagnitude, multiply, ONE, perturbStep, ZERO } from './extended.ts';
import type { Extended } from './extended.ts';
import { fixedToNumber, scaledFixed } from './precision.ts';
import type { View } from './precision.ts';

export const INTERIOR = -1;
const TWO = extended(2);
const BLA_EPSILON_BITS = 42;
/** A reused reference may be at most 2^24 CSS pixels from the view centre. */
const MAX_REFERENCE_OFFSET_BITS = 24;

export function iterationBudget(logScale: number): number {
  return Math.ceil((800 + Math.max(0, -logScale - 8) * 32) / 512) * 512;
}

function smooth(iteration: number, logRadius: number): number {
  return iteration + 1 - Math.log2(logRadius);
}

export function insideFixed(cr: bigint, ci: bigint, bits: number): boolean {
  const unit = 1n << BigInt(bits);
  const y2 = ci * ci;
  if ((cr + unit) ** 2n + y2 <= unit * unit / 16n) return true;
  const x = cr - unit / 4n;
  const q = x * x + y2;
  return q * (q + x * unit) <= y2 * unit * unit / 4n;
}

export function directDouble(cr: number, ci: number, limit: number): number {
  const q = (cr - 0.25) ** 2 + ci * ci;
  if (q * (q + cr - 0.25) <= 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci <= 1 / 16) return INTERIOR;
  let re = 0, im = 0, r2 = 0, i2 = 0;
  let savedRe = 0, savedIm = 0, checkpoint = 32;
  for (let n = 1; n <= limit; n++) {
    im = 2 * re * im + ci;
    re = r2 - i2 + cr;
    r2 = re * re;
    i2 = im * im;
    if (r2 + i2 > 256) return smooth(n, Math.log2(Math.hypot(re, im)));
    // Exact repeated states cannot escape later. Check sparsely to keep the
    // common, quickly escaping path cheap; no approximate interior threshold.
    if ((n & 31) === 0) {
      if (re === savedRe && im === savedIm) return INTERIOR;
      if (n === checkpoint) { savedRe = re; savedIm = im; checkpoint *= 2; }
    }
  }
  return INTERIOR;
}

/** Slow correctness path for perturbation glitches, also used as a test oracle. */
export function directFixed(cr: bigint, ci: bigint, bits: number, limit: number): number {
  if (insideFixed(cr, ci, bits)) return INTERIOR;
  const shift = BigInt(bits);
  const bailout = 256n << (shift * 2n);
  let re = 0n, im = 0n;
  let savedRe = 0n, savedIm = 0n, checkpoint = 1;
  for (let n = 1; n <= limit; n++) {
    const r2 = re * re, i2 = im * im;
    im = ((2n * re * im) >> shift) + ci;
    re = ((r2 - i2) >> shift) + cr;
    if (re * re + im * im > bailout) return smooth(n, logMagnitude(fromFixed(re, im, bits)));
    if (re === savedRe && im === savedIm) return INTERIOR;
    if (n === checkpoint) {
      savedRe = re; savedIm = im; checkpoint *= 2;
    }
  }
  return INTERIOR;
}

interface BLA {
  a: Extended;
  b: Extended;
  logRadius: number;
  length: number;
  ar: number; ai: number; br: number; bi: number;
  radius: number; radiusSquared: number;
}

function bla(a: Extended, b: Extended, logRadius: number, length: number): BLA {
  const radius = 2 ** logRadius * (1 - 8 * Number.EPSILON);
  return { a, b, logRadius, length, radius, radiusSquared: radius * radius,
    ar: a.re * 2 ** a.exp, ai: a.im * 2 ** a.exp,
    br: b.re * 2 ** b.exp, bi: b.im * 2 ** b.exp };
}

export interface Reference {
  orbit: Extended[];
  real: Float64Array;
  imag: Float64Array;
  levels: (BLA | undefined)[][];
}

/** Called periodically so stale jobs can be cancelled without restarting workers. */
export type Checkpoint = () => Promise<void>;

export async function buildReference(view: View, limit: number, logDeltaRadius: number, checkpoint: Checkpoint): Promise<Reference> {
  const orbit: Extended[] = [ZERO];
  const shift = BigInt(view.bits);
  const bailout = 256n << (shift * 2n);
  let re = 0n, im = 0n;
  for (let n = 1; n <= limit; n++) {
    const r2 = re * re, i2 = im * im;
    im = ((2n * re * im) >> shift) + view.im;
    re = ((r2 - i2) >> shift) + view.re;
    orbit.push(fromFixed(re, im, view.bits));
    if (re * re + im * im > bailout) break;
    if (n % 128 === 0) await checkpoint();
  }
  const real = Float64Array.from(orbit, z => z.re * 2 ** z.exp);
  const imag = Float64Array.from(orbit, z => z.im * 2 ** z.exp);
  const first: BLA[] = [];
  // Start at reference index 1: index 0 is a nonlinear step (Z_0 = 0).
  for (let m = 1; m + 1 < orbit.length; m++) {
    const a = multiply(TWO, orbit[m]);
    const logRadius = logMagnitude(orbit[m + 1]) < 3 ? logMagnitude(a) - BLA_EPSILON_BITS : -Infinity;
    first.push(bla(a, ONE, logRadius, 1));
  }
  const levels: (BLA | undefined)[][] = [first];
  let last: (BLA | undefined)[] = first;
  while (last.length > 1) {
    const level: (BLA | undefined)[] = [];
    for (let i = 0; i < last.length; i += 2) {
      const x = last[i], y = last[i + 1];
      if (!x || !y) { level.push(undefined); continue; }
      const radius = Math.min(x.logRadius,
        logDifference(y.logRadius, logMagnitude(x.b) + logDeltaRadius) - logMagnitude(x.a));
      level.push(bla(multiply(y.a, x.a), add(multiply(y.a, x.b), y.b), radius, x.length + y.length));
      if (i % 512 === 0) await checkpoint();
    }
    levels.push(level);
    last = level;
  }
  return { orbit, real, imag, levels };
}

function lookupExtended(reference: Reference, m: number, logDelta: number, remaining: number): BLA | undefined {
  if (m === 0) return undefined;
  const index = m - 1;
  let selected: BLA | undefined;
  for (let level = 0, stride = 1; level < reference.levels.length && index % stride === 0; level++, stride *= 2) {
    const candidate = reference.levels[level][index / stride];
    if (!candidate || candidate.length > remaining || !(logDelta < candidate.logRadius)) break;
    selected = candidate;
  }
  return selected;
}

/** Native BLA lookup without a logarithm/hypotenuse on every orbit step. */
function lookupNative(reference: Reference, m: number, dr: number, di: number, remaining: number): BLA | undefined {
  if (m === 0) return undefined;
  const index = m - 1, squared = dr * dr + di * di;
  let magnitude: number | undefined;
  let selected: BLA | undefined;
  for (let level = 0, stride = 1; level < reference.levels.length && index % stride === 0; level++, stride *= 2) {
    const candidate = reference.levels[level][index / stride];
    if (!candidate || candidate.length > remaining) break;
    // Squared doubles underflow at extreme depths. Preserve the stable hypot
    // comparison there, rather than treating two tiny, nonzero radii as zero.
    const within = candidate.radiusSquared >= 1e-280 ? squared < candidate.radiusSquared
      : (magnitude ??= Math.hypot(dr, di)) < candidate.radius;
    if (!within || !Number.isFinite(candidate.ar + candidate.ai + candidate.br + candidate.bi)) break;
    selected = candidate;
  }
  return selected;
}

export interface SampleStats { fallbacks: number; skipped: number }

function perturbNative(reference: Reference, dcRe: number, dcIm: number, limit: number, fallback: () => number, stats: SampleStats): number {
  let dr = 0, di = 0, m = 0, n = 0;
  while (n < limit) {
    const block = lookupNative(reference, m, dr, di, limit - n);
    if (block) {
      const nextRe = block.ar * dr - block.ai * di + block.br * dcRe - block.bi * dcIm;
      di = block.ar * di + block.ai * dr + block.br * dcIm + block.bi * dcRe;
      dr = nextRe;
      m += block.length; n += block.length; stats.skipped += block.length - 1;
    } else {
      const zr = reference.real[m], zi = reference.imag[m];
      const nextRe = 2 * (zr * dr - zi * di) + dr * dr - di * di + dcRe;
      di = 2 * (zr * di + zi * dr + dr * di) + dcIm;
      dr = nextRe;
      m++; n++;
    }
    const zr = reference.real[m], zi = reference.imag[m];
    const totalRe = zr + dr, totalIm = zi + di;
    const squared = totalRe * totalRe + totalIm * totalIm;
    if (!Number.isFinite(squared)) return fallback();
    if (squared > 256) return smooth(n, 0.5 * Math.log2(squared));
    let rebase: boolean;
    if (squared >= 1e-280) {
      if (squared < (zr * zr + zi * zi) * 1e-14) return fallback();
      rebase = squared < dr * dr + di * di;
    } else {
      const radius = Math.hypot(totalRe, totalIm);
      if (radius < Math.hypot(zr, zi) * 1e-7) return fallback();
      rebase = radius < Math.hypot(dr, di);
    }
    if (rebase || m === reference.orbit.length - 1) {
      dr = totalRe; di = totalIm; m = 0;
    }
  }
  return INTERIOR;
}

function perturbExtended(reference: Reference, dc: Extended, limit: number, fallback: () => number, stats: SampleStats): number {
  let delta = ZERO, m = 0, n = 0;
  while (n < limit) {
    const block = lookupExtended(reference, m, logMagnitude(delta), limit - n);
    if (block) {
      delta = linear(block.a, delta, block.b, dc);
      m += block.length; n += block.length; stats.skipped += block.length - 1;
    } else {
      delta = perturbStep(reference.orbit[m], delta, dc);
      m++; n++;
    }
    const z = reference.orbit[m];
    const total = add(z, delta);
    const logRadius = logMagnitude(total);
    if (logRadius > 4) return smooth(n, logRadius);
    if (logRadius < logMagnitude(z) - 24 || Number.isNaN(logRadius)) return fallback();
    if (logRadius < logMagnitude(delta) || m === reference.orbit.length - 1) {
      delta = total; m = 0;
    }
  }
  return INTERIOR;
}

export interface Sampler {
  sample(x: number, y: number): number;
  stats: SampleStats;
}

export interface ReferenceCache {
  entry?: { view: View; limit: number; logRadius: number; reference: Reference };
}

export async function createSampler(view: View, cssWidth: number, cssHeight: number, limit: number, checkpoint: Checkpoint, cache: ReferenceCache = {}): Promise<Sampler> {
  const stats: SampleStats = { fallbacks: 0, skipped: 0 };
  if (view.logScale > -38) {
    const cr = fixedToNumber(view.re, view.bits), ci = fixedToNumber(view.im, view.bits);
    const scale = 2 ** view.logScale;
    return { stats, sample: (x, y) => directDouble(cr + x * scale, ci - y * scale, limit) };
  }
  const logRadius = view.logScale + Math.log2(Math.hypot(cssWidth, cssHeight) / 2 + 1);
  const centreRe = fixedToNumber(view.re, view.bits), centreIm = fixedToNumber(view.im, view.bits);
  const q = (centreRe - 0.25) ** 2 + centreIm ** 2;
  const cardioid = q * (q + centreRe - 0.25) - centreIm ** 2 / 4;
  const bulb = (centreRe + 1) ** 2 + centreIm ** 2 - 1 / 16;
  // A conservative derivative/rounding bound over [-4,4]^2. Away from the
  // boundary, avoid doing multi-precision cardioid tests for every pixel.
  const margin = 8192 * (Number.EPSILON + 2 ** logRadius);
  const nearby = Math.abs(centreRe) < 4 && Math.abs(centreIm) < 4;
  if (nearby && (cardioid < -margin || bulb < -margin)) return { stats, sample: () => INTERIOR };
  const exactInterior = nearby && (cardioid <= margin || bulb <= margin);

  let entry = cache.entry;
  let offset = ZERO;
  if (entry && entry.view.bits >= view.bits && entry.limit >= limit) {
    const shift = BigInt(entry.view.bits - view.bits);
    offset = fromFixed((view.re << shift) - entry.view.re, (view.im << shift) - entry.view.im, entry.view.bits);
    const logOffset = logMagnitude(offset);
    const maxLog = Math.max(logOffset, logRadius);
    const bound = maxLog + Math.log2(2 ** (logOffset - maxLog) + 2 ** (logRadius - maxLog));
    // Pixel deltas are added to the offset in 53-bit doubles. Zooming far into
    // an off-centre point would leave too few bits to tell pixels apart
    // (precision bits never shrink, so `bits` alone does not invalidate it).
    if (bound > entry.logRadius || logOffset - view.logScale > MAX_REFERENCE_OFFSET_BITS) entry = undefined;
  } else entry = undefined;
  if (!entry) {
    const paddedRadius = logRadius + 2;
    const reference = await buildReference(view, limit, paddedRadius, checkpoint);
    entry = { view: { ...view }, limit, logRadius: paddedRadius, reference };
    cache.entry = entry;
    offset = ZERO;
  }
  const reference = entry.reference;
  const exponent = Math.floor(view.logScale);
  const mantissa = 2 ** (view.logScale - exponent);
  const native = view.logScale > -900;
  const scale = 2 ** view.logScale;
  const offsetRe = offset.re * 2 ** offset.exp, offsetIm = offset.im * 2 ** offset.exp;
  return { stats, sample(x, y) {
    // Fixed-point is only used per pixel for exact interior tests or detected glitches.
    let cr: bigint | undefined, ci: bigint | undefined;
    const coordinates = () => {
      cr ??= view.re + scaledFixed(x, view.logScale, view.bits);
      ci ??= view.im - scaledFixed(y, view.logScale, view.bits);
    };
    if (exactInterior) {
      coordinates();
      if (insideFixed(cr!, ci!, view.bits)) return INTERIOR;
    }
    const fallback = () => {
      coordinates(); stats.fallbacks++;
      return directFixed(cr!, ci!, view.bits, limit);
    };
    return native
      ? perturbNative(reference, offsetRe + x * scale, offsetIm - y * scale, limit, fallback, stats)
      : perturbExtended(reference, add(offset, extended(x * mantissa, -y * mantissa, exponent)), limit, fallback, stats);
  } };
}

export { color, COLOR_PERIOD } from './palette.ts';
