/**
 * The reference orbit and its BLA (bivariate linear approximation) tables.
 * The orbit is computed once in BigInt fixed point at the reference centre
 * (computeOrbit, worker 0) and shared; every worker then converts it to
 * doubles and merges BLA blocks level by level (referenceFromOrbit).
 */
import { add, extended, fromFixed, logDifference, logMagnitude, multiply, ONE } from '../math/extended.ts';
import type { Extended } from '../math/extended.ts';
import type { View } from '../math/precision.ts';
import type { OrbitData } from './reference.ts';

const TWO = extended(2);
/**
 * BLA drops |δ|² once |δ| < 2^-36 |2Z|. The relative error is equivalent to
 * moving a sample by ~1e-8 pixel; in chaotic boundary regions the exact
 * escape count already varies far more than that within 1e-3 pixel. 2^-42
 * skipped up to 5x fewer iterations at depth with no visible difference.
 */
const BLA_EPSILON_BITS = 36;

/** One BLA block: δ after `length` steps is a δ + b δc while |δ| < radius (and its log2, logRadius). */
export interface BLA {
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

/** Native BLA tables: per level, six doubles per block: A (re, im), B (re, im), radius², radius. */
export const NATIVE_FIELDS = 6;

/** A reference orbit in doubles with its BLA tables, as each worker uses it. */
export interface Reference {
  real: Float64Array;
  imag: Float64Array;
  /** Level L holds blocks of 2^L steps starting at orbit index 1 + j 2^L; radius 0 means unusable. */
  native: Float64Array[];
  /**
   * Squared level-0 BLA radius per orbit index (0 where none applies). Every
   * longer block starting at m has a radius no larger, so a failed check here
   * skips the whole lookup, the common case on long, poorly skippable orbits.
   */
  firstRadiusSquared: Float64Array;
  /**
   * Squared level-1 radius per orbit index (0 where no two-step block starts
   * there). A single step is better done exactly than as a level-0 block (which
   * drops δ²), so plain steps continue until a block of 2 or more may apply.
   */
  skipRadiusSquared: Float64Array;
  /** |Z_m|² · 1e-14: below this |z|² has lost too many bits to cancellation (a glitch). */
  glitch: Float64Array;
  /** Extended-exponent orbit and BLA tables, only built for views that need them (below 2^-900). */
  orbit?: Extended[];
  levels?: (BLA | undefined)[][];
}

/** Called periodically so stale jobs can be cancelled without restarting workers. */
export type Checkpoint = () => Promise<void>;

/** The expensive, multi-precision part of a reference: computed once, then shared by every worker. */
export async function computeOrbit(view: View, limit: number, checkpoint: Checkpoint): Promise<OrbitData> {
  const data = { re: new Float64Array(limit + 1), im: new Float64Array(limit + 1), exp: new Float64Array(limit + 1) };
  const shift = BigInt(view.bits);
  const bailout = 256n << (shift * 2n);
  const half = shift - 1n;
  // The squares of z serve both the escape test and the next step: three
  // multiplications per iteration instead of five, with identical values.
  let re = 0n, im = 0n, r2 = 0n, i2 = 0n, length = 1;
  for (let n = 1; n <= limit; n++) {
    im = ((re * im) >> half) + view.im;
    re = ((r2 - i2) >> shift) + view.re;
    const z = fromFixed(re, im, view.bits);
    data.re[n] = z.re; data.im[n] = z.im; data.exp[n] = z.exp;
    length = n + 1;
    r2 = re * re; i2 = im * im;
    if (r2 + i2 > bailout) break;
    if (n % 128 === 0) await checkpoint();
  }
  return { re: data.re.slice(0, length), im: data.im.slice(0, length), exp: data.exp.slice(0, length) };
}

/** Views at or below this scale need extended-exponent deltas (doubles would underflow). */
export const EXTENDED_LOG_SCALE = -900;

/**
 * Double-precision orbit and BLA table from a (possibly received) orbit;
 * cheap next to the BigInt orbit. Blocks are merged with extended exponents
 * (long products overflow doubles), but only the native coefficients are
 * kept unless `extended` asks for the object tables as well.
 */
export async function referenceFromOrbit(data: OrbitData, logDeltaRadius: number, checkpoint: Checkpoint, extended = false): Promise<Reference> {
  const length = data.re.length;
  const point = (i: number): Extended => ({ re: data.re[i], im: data.im[i], exp: data.exp[i] });
  const real = new Float64Array(length), imag = new Float64Array(length);
  for (let i = 0; i < length; i++) { real[i] = data.re[i] * 2 ** data.exp[i]; imag[i] = data.im[i] * 2 ** data.exp[i]; }
  const store = (blocks: (BLA | undefined)[]) => {
    const table = new Float64Array(blocks.length * NATIVE_FIELDS);
    blocks.forEach((block, i) => {
      if (!block || !Number.isFinite(block.ar + block.ai + block.br + block.bi)) return;
      table.set([block.ar, block.ai, block.br, block.bi, block.radiusSquared, block.radius], i * NATIVE_FIELDS);
    });
    return table;
  };
  const first: BLA[] = [];
  // Start at reference index 1: index 0 is a nonlinear step (Z_0 = 0).
  for (let m = 1; m + 1 < length; m++) {
    const z = point(m), a = multiply(TWO, z);
    const logRadius = logMagnitude(point(m + 1)) < 3 ? logMagnitude(a) - BLA_EPSILON_BITS : -Infinity;
    first.push(bla(a, ONE, logRadius, 1));
  }
  const native = [store(first)];
  const levels: (BLA | undefined)[][] | undefined = extended ? [first] : undefined;
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
    native.push(store(level));
    levels?.push(level);
    last = level;
  }
  const firstRadiusSquared = new Float64Array(length);
  for (let i = 0; i < first.length; i++) firstRadiusSquared[i + 1] = native[0][i * NATIVE_FIELDS + 4];
  const skipRadiusSquared = new Float64Array(length);
  if (native.length > 1) for (let j = 0; j * NATIVE_FIELDS < native[1].length; j++) skipRadiusSquared[1 + 2 * j] = native[1][j * NATIVE_FIELDS + 4];
  const glitch = new Float64Array(length);
  for (let i = 0; i < length; i++) glitch[i] = (real[i] * real[i] + imag[i] * imag[i]) * 1e-14;
  return { real, imag, native, firstRadiusSquared, skipRadiusSquared, glitch,
    orbit: extended ? Array.from({ length }, (_, i) => point(i)) : undefined, levels };
}

/** Orbit and tables for a view in one go (when no shared orbit is supplied). */
export async function buildReference(view: View, limit: number, logDeltaRadius: number, checkpoint: Checkpoint): Promise<Reference> {
  return referenceFromOrbit(await computeOrbit(view, limit, checkpoint), logDeltaRadius, checkpoint,
    view.logScale <= EXTENDED_LOG_SCALE + 100);
}

/** Extended-exponent BLA lookup: the longest usable block at m, if any. */
export function lookupExtended(reference: Reference, m: number, logDelta: number, remaining: number): BLA | undefined {
  if (m === 0) return undefined;
  const index = m - 1;
  let selected: BLA | undefined;
  const levels = reference.levels!;
  for (let level = 0, stride = 1; level < levels.length && index % stride === 0; level++, stride *= 2) {
    const candidate = levels[level][index / stride];
    if (!candidate || candidate.length > remaining || !(logDelta < candidate.logRadius)) break;
    selected = candidate;
  }
  return selected;
}

/** Native BLA lookup: the longest usable block level at m, or -1. No logarithm per step. */
export function lookupNative(reference: Reference, m: number, dr: number, di: number, remaining: number): number {
  if (m === 0) return -1;
  const index = m - 1, squared = dr * dr + di * di, tables = reference.native;
  let magnitude: number | undefined;
  let selected = -1;
  for (let level = 0, stride = 1; level < tables.length && index % stride === 0 && stride <= remaining; level++, stride *= 2) {
    const table = tables[level], offset = (index / stride) * NATIVE_FIELDS;
    if (offset >= table.length) break;
    // Squared doubles underflow at extreme depths. Preserve the stable hypot
    // comparison there, rather than treating two tiny, nonzero radii as zero.
    const radiusSquared = table[offset + 4];
    const within = radiusSquared >= 1e-280 ? squared < radiusSquared
      : (magnitude ??= Math.hypot(dr, di)) < table[offset + 5];
    if (!within) break;
    selected = level;
  }
  return selected;
}
