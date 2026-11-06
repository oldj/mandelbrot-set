import { add, extended, fromFixed, linear, logDifference, logMagnitude, multiply, ONE, perturbStep, ZERO } from './extended.ts';
import type { Extended } from './extended.ts';
import { fixedToNumber, scaledFixed } from './precision.ts';
import type { View } from './precision.ts';
import { DEEP_LOG_SCALE, interiorStatus, referenceOffset, referenceSpec, viewLogRadius } from './reference.ts';
import type { OrbitData, ReferenceSpec } from './reference.ts';

export const INTERIOR = -1;
const TWO = extended(2);
/**
 * BLA drops |δ|² once |δ| < 2^-36 |2Z|. The relative error is equivalent to
 * moving a sample by ~1e-8 pixel; in chaotic boundary regions the exact
 * escape count already varies far more than that within 1e-3 pixel. 2^-42
 * skipped up to 5x fewer iterations at depth with no visible difference.
 */
const BLA_EPSILON_BITS = 36;

export function iterationBudget(logScale: number): number {
  return Math.ceil((800 + Math.max(0, -logScale - 8) * 32) / 512) * 512;
}

function smooth(iteration: number, logRadius: number): number {
  return iteration + 1 - Math.log2(logRadius);
}

/**
 * Distance estimate of the most recent sample, in units of the pixel size
 * the iteration was given (NaN for interior, unresolved or fallback samples).
 * Kernels track z' = dz/dc times the pixel size (z'_{n+1} = 2 z_n z'_n + pixel),
 * which stays within double range at any depth, and at escape
 * |z| ln|z| / |z'| is the distance to the set within a factor of about 2.
 */
let distance = NaN;
export function lastDistance(): number { return distance; }
const escapeDistance = (squared: number, dr: number, di: number) => Math.sqrt(squared) * 0.5 * Math.log(squared) / Math.hypot(dr, di);

export function insideFixed(cr: bigint, ci: bigint, bits: number): boolean {
  const unit = 1n << BigInt(bits);
  const y2 = ci * ci;
  if ((cr + unit) ** 2n + y2 <= unit * unit / 16n) return true;
  const x = cr - unit / 4n;
  const q = x * x + y2;
  return q * (q + x * unit) <= y2 * unit * unit / 4n;
}

/** Sets lastDistance() on escape, in units of `pixel` (the distance from c to c + 1 pixel). */
export function directDouble(cr: number, ci: number, limit: number, pixel = 1): number {
  const q = (cr - 0.25) ** 2 + ci * ci;
  if (q * (q + cr - 0.25) <= 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci <= 1 / 16) return INTERIOR;
  let re = 0, im = 0, r2 = 0, i2 = 0, dr = 0, di = 0;
  let savedRe = 0, savedIm = 0, checkpoint = 32;
  for (let n = 1; n <= limit; n++) {
    const next = 2 * (re * dr - im * di) + pixel;
    di = 2 * (re * di + im * dr); dr = next;
    im = 2 * re * im + ci;
    re = r2 - i2 + cr;
    r2 = re * re;
    i2 = im * im;
    if (r2 + i2 > 256) {
      distance = escapeDistance(r2 + i2, dr, di);
      return smooth(n, Math.log2(Math.hypot(re, im)));
    }
    // Exact repeated states cannot escape later. Check sparsely to keep the
    // common, quickly escaping path cheap; no approximate interior threshold.
    if ((n & 31) === 0) {
      if (re === savedRe && im === savedIm) return INTERIOR;
      if (n === checkpoint) { savedRe = re; savedIm = im; checkpoint *= 2; }
    }
  }
  return INTERIOR;
}

/** Main cardioid or period-2 bulb, exactly as directDouble tests it. */
function insideDouble(cr: number, ci: number): boolean {
  const q = (cr - 0.25) ** 2 + ci * ci;
  return q * (q + cr - 0.25) <= 0.25 * ci * ci || (cr + 1) ** 2 + ci * ci <= 1 / 16;
}

const LANE_CHUNK = 32;

/**
 * Interior proof for a double-precision orbit at z with candidate period P:
 * iterate P steps while bounding the image of the disk D(z, r0); if it lands
 * inside D, f^P maps D into itself and the orbit can never escape.
 * |f(w) - f(z)| <= r (2|z| + r), plus a rounding bound for z^2 + c.
 */
function trappedDouble(cr: number, ci: number, zr: number, zi: number, period: number, distance: number): boolean {
  const cMagnitude = Math.hypot(cr, ci);
  // Several disk sizes at once: small ones suit weakly contracting cycles,
  // large ones keep rounding bounds negligible near super-attracting ones.
  const radius0 = 8 * (distance + ROUNDING * Math.hypot(zr, zi));
  let ra = radius0, rb = radius0 * 2 ** 8, rc = radius0 * 2 ** 16, rd = radius0 * 2 ** 24;
  let re = zr, im = zi, r2 = zr * zr, i2 = zi * zi;
  for (let k = 0; k < period; k++) {
    const twice = 2 * Math.sqrt(r2 + i2), rounding = ROUNDING * (r2 + i2 + cMagnitude);
    ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
    rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
    im = 2 * re * im + ci; re = r2 - i2 + cr; r2 = re * re; i2 = im * im;
    if (r2 + i2 > 256 || !(ra < 1)) return false;
  }
  const gap = Math.hypot(re - zr, im - zi) + ROUNDING * (Math.hypot(re, im) + Math.hypot(zr, zi));
  return gap + ra <= radius0 || gap + rb <= radius0 * 2 ** 8 || gap + rc <= radius0 * 2 ** 16 || gap + rd <= radius0 * 2 ** 24;
}

/**
 * directDouble for a row of pixels sharing one imaginary part, three orbits
 * at a time. A single orbit is latency-bound (each iteration waits on the
 * previous one); interleaving independent orbits keeps the FPU busy and is
 * about 2x faster. Each lane performs exactly directDouble's operations, so
 * escapes are found at the same iteration with the same value.
 *
 * Chunks are a fixed 32 iterations (shorter only near the budget), escapes
 * are handled inline, and saved states are compared on chunk boundaries: an
 * exactly repeated state can never escape (as in directDouble), and a near
 * return starts an interior proof (trappedDouble) on a copy of the orbit.
 * Distance estimates (as directDouble's) go to `distances`, NaN for interiors.
 * Returns how many samples reached the budget unresolved.
 */
export function directRow(cr: Float64Array, ci: number, count: number, limit: number, out: Float64Array,
  distances?: Float64Array, pixel = 1): number {
  let next = 0, unresolved = 0;
  const take = () => {
    while (next < count) {
      const i = next++;
      if (insideDouble(cr[i], ci)) { out[i] = INTERIOR; if (distances) distances[i] = NaN; }
      else return i;
    }
    return -1;
  };
  // Per lane: pixel, c, z and its squares, iteration at the chunk start, the
  // saved state with its iteration, the next save point and proof work spent.
  // An idle lane iterates c = 0, which stays at 0 and never escapes.
  let p0 = take(), c0 = p0 < 0 ? 0 : cr[p0], q0 = p0 < 0 ? 0 : ci;
  let p1 = take(), c1 = p1 < 0 ? 0 : cr[p1], q1 = p1 < 0 ? 0 : ci;
  let p2 = take(), c2 = p2 < 0 ? 0 : cr[p2], q2 = p2 < 0 ? 0 : ci;
  let x0 = 0, y0 = 0, a0 = 0, b0 = 0, n0 = 0, s0 = 0, t0 = 0, m0 = 0, k0 = 32, w0 = 0, u0 = 0, v0 = 0;
  let x1 = 0, y1 = 0, a1 = 0, b1 = 0, n1 = 0, s1 = 0, t1 = 0, m1 = 0, k1 = 32, w1 = 0, u1 = 0, v1 = 0;
  let x2 = 0, y2 = 0, a2 = 0, b2 = 0, n2 = 0, s2 = 0, t2 = 0, m2 = 0, k2 = 32, w2 = 0, u2 = 0, v2 = 0;
  let g = 0;
  while (p0 >= 0 || p1 >= 0 || p2 >= 0) {
    let chunk = LANE_CHUNK;
    if (p0 >= 0) chunk = Math.min(chunk, limit - n0);
    if (p1 >= 0) chunk = Math.min(chunk, limit - n1);
    if (p2 >= 0) chunk = Math.min(chunk, limit - n2);
    let step = 0;
    while (step < chunk) {
      // The hot loop stays minimal; escapes are handled outside it, then the chunk resumes.
      while (step < chunk) {
        g = 2 * (x0 * u0 - y0 * v0) + pixel; v0 = 2 * (x0 * v0 + y0 * u0); u0 = g;
        y0 = 2 * x0 * y0 + q0; x0 = a0 - b0 + c0; a0 = x0 * x0; b0 = y0 * y0;
        g = 2 * (x1 * u1 - y1 * v1) + pixel; v1 = 2 * (x1 * v1 + y1 * u1); u1 = g;
        y1 = 2 * x1 * y1 + q1; x1 = a1 - b1 + c1; a1 = x1 * x1; b1 = y1 * y1;
        g = 2 * (x2 * u2 - y2 * v2) + pixel; v2 = 2 * (x2 * v2 + y2 * u2); u2 = g;
        y2 = 2 * x2 * y2 + q2; x2 = a2 - b2 + c2; a2 = x2 * x2; b2 = y2 * y2;
        step++;
        if (a0 + b0 > 256 || a1 + b1 > 256 || a2 + b2 > 256) break;
      }
      // A reloaded lane starts mid-chunk: n counts from -step, so after the chunk it is the true
      // iteration count; its save point m stays absolute (0), so a fresh z = 0 is no repeat.
      if (a0 + b0 > 256) {
        out[p0] = smooth(n0 + step, Math.log2(Math.hypot(x0, y0)));
        if (distances) distances[p0] = escapeDistance(a0 + b0, u0, v0);
        p0 = take(); c0 = p0 < 0 ? 0 : cr[p0]; q0 = p0 < 0 ? 0 : ci;
        x0 = y0 = a0 = b0 = s0 = t0 = m0 = w0 = u0 = v0 = 0; n0 = -step; k0 = 32;
      }
      if (a1 + b1 > 256) {
        out[p1] = smooth(n1 + step, Math.log2(Math.hypot(x1, y1)));
        if (distances) distances[p1] = escapeDistance(a1 + b1, u1, v1);
        p1 = take(); c1 = p1 < 0 ? 0 : cr[p1]; q1 = p1 < 0 ? 0 : ci;
        x1 = y1 = a1 = b1 = s1 = t1 = m1 = w1 = u1 = v1 = 0; n1 = -step; k1 = 32;
      }
      if (a2 + b2 > 256) {
        out[p2] = smooth(n2 + step, Math.log2(Math.hypot(x2, y2)));
        if (distances) distances[p2] = escapeDistance(a2 + b2, u2, v2);
        p2 = take(); c2 = p2 < 0 ? 0 : cr[p2]; q2 = p2 < 0 ? 0 : ci;
        x2 = y2 = a2 = b2 = s2 = t2 = m2 = w2 = u2 = v2 = 0; n2 = -step; k2 = 32;
      }
      if (p0 < 0 && p1 < 0 && p2 < 0) break;
      // Lanes reloaded here start at n = 0; the budget is far more than one chunk away.
    }
    n0 += chunk; n1 += chunk; n2 += chunk;
    // After a short chunk, boundaries shift: re-save so compared states stay a multiple of 32 apart.
    const realign = chunk !== LANE_CHUNK;
    if (p0 >= 0) {
      let done = n0 >= limit;
      if (!done && x0 === s0 && y0 === t0 && n0 > m0) done = true;
      else if (!done && n0 > m0 && m0 > 0) {
        const dx = x0 - s0, dy = y0 - t0, distance = dx * dx + dy * dy, period = n0 - m0;
        if (distance < TRAP_RETURN_SQUARED * (s0 * s0 + t0 * t0) && w0 + period <= n0) {
          w0 += period;
          done = trappedDouble(c0, q0, x0, y0, period, Math.sqrt(distance));
        }
      }
      if (done) {
        out[p0] = INTERIOR;
        if (distances) distances[p0] = NaN;
        if (n0 >= limit && !(x0 === s0 && y0 === t0)) unresolved++;
        p0 = take(); c0 = p0 < 0 ? 0 : cr[p0]; q0 = p0 < 0 ? 0 : ci;
        x0 = y0 = a0 = b0 = n0 = s0 = t0 = m0 = w0 = u0 = v0 = 0; k0 = 32;
      } else if (n0 >= k0 || realign) {
        s0 = x0; t0 = y0; m0 = n0;
        if (n0 >= k0) k0 *= 2;
      }
    }
    if (p1 >= 0) {
      let done = n1 >= limit;
      if (!done && x1 === s1 && y1 === t1 && n1 > m1) done = true;
      else if (!done && n1 > m1 && m1 > 0) {
        const dx = x1 - s1, dy = y1 - t1, distance = dx * dx + dy * dy, period = n1 - m1;
        if (distance < TRAP_RETURN_SQUARED * (s1 * s1 + t1 * t1) && w1 + period <= n1) {
          w1 += period;
          done = trappedDouble(c1, q1, x1, y1, period, Math.sqrt(distance));
        }
      }
      if (done) {
        out[p1] = INTERIOR;
        if (distances) distances[p1] = NaN;
        if (n1 >= limit && !(x1 === s1 && y1 === t1)) unresolved++;
        p1 = take(); c1 = p1 < 0 ? 0 : cr[p1]; q1 = p1 < 0 ? 0 : ci;
        x1 = y1 = a1 = b1 = n1 = s1 = t1 = m1 = w1 = u1 = v1 = 0; k1 = 32;
      } else if (n1 >= k1 || realign) {
        s1 = x1; t1 = y1; m1 = n1;
        if (n1 >= k1) k1 *= 2;
      }
    }
    if (p2 >= 0) {
      let done = n2 >= limit;
      if (!done && x2 === s2 && y2 === t2 && n2 > m2) done = true;
      else if (!done && n2 > m2 && m2 > 0) {
        const dx = x2 - s2, dy = y2 - t2, distance = dx * dx + dy * dy, period = n2 - m2;
        if (distance < TRAP_RETURN_SQUARED * (s2 * s2 + t2 * t2) && w2 + period <= n2) {
          w2 += period;
          done = trappedDouble(c2, q2, x2, y2, period, Math.sqrt(distance));
        }
      }
      if (done) {
        out[p2] = INTERIOR;
        if (distances) distances[p2] = NaN;
        if (n2 >= limit && !(x2 === s2 && y2 === t2)) unresolved++;
        p2 = take(); c2 = p2 < 0 ? 0 : cr[p2]; q2 = p2 < 0 ? 0 : ci;
        x2 = y2 = a2 = b2 = n2 = s2 = t2 = m2 = w2 = u2 = v2 = 0; k2 = 32;
      } else if (n2 >= k2 || realign) {
        s2 = x2; t2 = y2; m2 = n2;
        if (n2 >= k2) k2 *= 2;
      }
    }
  }
  return unresolved;
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

/** Native BLA tables: per level, six doubles per block: A (re, im), B (re, im), radius², radius. */
const NATIVE_FIELDS = 6;

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
  const glitch = new Float64Array(length);
  for (let i = 0; i < length; i++) glitch[i] = (real[i] * real[i] + imag[i] * imag[i]) * 1e-14;
  return { real, imag, native, firstRadiusSquared, glitch,
    orbit: extended ? Array.from({ length }, (_, i) => point(i)) : undefined, levels };
}

export async function buildReference(view: View, limit: number, logDeltaRadius: number, checkpoint: Checkpoint): Promise<Reference> {
  return referenceFromOrbit(await computeOrbit(view, limit, checkpoint), logDeltaRadius, checkpoint,
    view.logScale <= EXTENDED_LOG_SCALE + 100);
}

function lookupExtended(reference: Reference, m: number, logDelta: number, remaining: number): BLA | undefined {
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
function lookupNative(reference: Reference, m: number, dr: number, di: number, remaining: number): number {
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

export interface SampleStats { fallbacks: number; skipped: number; unresolved: number }

/** A return within 2^-10 of the base point (in squared terms) starts an interior proof attempt. */
const TRAP_RETURN_SQUARED = 2 ** -20;
/** |z|² must be this close (relatively) to |base|² for such a return to be possible. */
const TRAP_BAND = 2 ** -8;
/**
 * Interior orbits need far longer than this to settle; earlier returns are
 * transients. Periods 1 and 2 are skipped too: their attracting cycles lie only
 * in the main cardioid and period-2 bulb, which exact tests already settle.
 */
const PROOF_START = 128;
/** Generous bound on the relative rounding of one double operation chain. */
const ROUNDING = 2 ** -50;
/**
 * attractingCycle is tried on looser returns than the in-loop proof: within
 * 2^-2 of |base| (squared terms), with |z|² within 2^-2 of |base|². An attempt
 * needs 3P unspent steps (proof work stays within ~the steps executed), takes
 * at most NEWTON_PASSES laps, and the k-th failed one waits 4P 2^k before the
 * next: escaping orbits keep passing near repelling cycles.
 */
const NEWTON_RETURN_SQUARED = 2 ** -2, NEWTON_BAND = 2 ** -2, NEWTON_COST = 3, NEWTON_PASSES = 10;

/**
 * Interior proof by an attracting cycle. The orbit of an interior point can
 * take a very long time to settle near its cycle (each lap of a period-844
 * cycle may bring it only ~12% closer), so waiting for a close return, as
 * perturbNative's own proof does, costs tens of thousands of iterations per
 * pixel. Instead, from a rough return after P steps, Newton's method on
 * f^P(w) = w finds the cycle point directly, and the disk check below proves,
 * with rounding bounds, that f^P maps a disk around it into itself. Then f^P
 * has an attracting fixed point there (Schwarz lemma), and an attracting cycle
 * of z^2 + c always attracts the critical point 0 (Fatou), so the orbit of 0
 * stays bounded: c is interior, whether or not the orbit has come close yet.
 *
 * Runs from the orbit state (m0, δ = s) without changing it; each pass is P
 * single steps. Returns the steps spent, negated when the proof succeeded.
 */
function attractingCycle(reference: Reference, m0: number, sr: number, si: number, dcRe: number, dcIm: number,
  period: number, dcError: number): number {
  const real = reference.real, imag = reference.imag, end = real.length - 1;
  let spent = 0, radius0 = 0, previousStep = Infinity;
  for (let pass = 0; pass < NEWTON_PASSES; pass++) {
    // One lap from w = Z_m0 + s: f^P(w), its derivative D = (f^P)'(w), and,
    // after the first pass, bounds ra..rd on the images of D(w, r) for four
    // radii, as in perturbNative. The reference values' own rounding only
    // scales δ there (covered by the 4|Z||δ| term); it enters the totals at
    // the start, the end and on rebasing, which add it explicitly.
    const check = pass > 0;
    const startRe = real[m0] + sr, startIm = imag[m0] + si;
    const startError = ROUNDING * (Math.sqrt(real[m0] * real[m0] + imag[m0] * imag[m0]) + Math.sqrt(sr * sr + si * si));
    let ra = radius0, rb = radius0 * 16, rc = radius0 * 256, rd = radius0 * 4096;
    let m = m0, dr = sr, di = si, Dr = 1, Di = 0;
    for (let k = 0; k < period; k++) {
      const zr = real[m], zi = imag[m], tr = zr + dr, ti = zi + di;
      if (check) {
        const ref = Math.sqrt(zr * zr + zi * zi), delta = Math.sqrt(dr * dr + di * di);
        const twice = 2 * Math.sqrt(tr * tr + ti * ti), rounding = ROUNDING * (4 * ref * delta + delta * delta) + dcError;
        ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
        rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
      }
      const nextD = 2 * (tr * Dr - ti * Di);
      Di = 2 * (tr * Di + ti * Dr); Dr = nextD;
      const nextRe = 2 * (zr * dr - zi * di) + dr * dr - di * di + dcRe;
      di = 2 * (zr * di + zi * dr + dr * di) + dcIm; dr = nextRe;
      m++;
      const er = real[m] + dr, ei = imag[m] + di, squared = er * er + ei * ei;
      if (!(squared <= 256)) return spent + k;
      if (squared < dr * dr + di * di || m === end) {
        if (check) {
          const error = ROUNDING * (Math.sqrt(real[m] * real[m] + imag[m] * imag[m]) + Math.sqrt(dr * dr + di * di));
          ra += error; rb += error; rc += error; rd += error;
        }
        dr = er; di = ei; m = 0;
      }
    }
    spent += period;
    const gr = real[m] + dr - startRe, gi = imag[m] + di - startIm, lambda = Math.sqrt(Dr * Dr + Di * Di);
    if (check) {
      const error = ROUNDING * (Math.sqrt(real[m] * real[m] + imag[m] * imag[m]) + Math.sqrt(dr * dr + di * di));
      const distance = Math.sqrt(gr * gr + gi * gi) + startError + error;
      if (distance + ra < radius0 || distance + rb < radius0 * 16 || distance + rc < radius0 * 256
        || distance + rd < radius0 * 4096) return -spent;
    }
    // Newton for g(w) = f^P(w) - w: w -= g / (D - 1). Stop on a nearly
    // converged repelling cycle (wrong period, or c outside; within 2^-8 the
    // derivative is that of the cycle) or once steps stop shrinking.
    const ar = Dr - 1, ai = Di, den = ar * ar + ai * ai;
    const stepRe = (gr * ar + gi * ai) / den, stepIm = (gi * ar - gr * ai) / den;
    const step = Math.sqrt(stepRe * stepRe + stepIm * stepIm), size = Math.sqrt(startRe * startRe + startIm * startIm);
    if (!(lambda < 1) && !(step > 2 ** -8 * size)) break;
    if (!(step < previousStep) && pass > 2) break;
    sr -= stepRe; si -= stepIm;
    previousStep = step;
    // Newton converges quadratically: the fixed point lies well within one
    // step of the new w, so the disks start at 4x the step, scaled for |λ|.
    radius0 = lambda < 1 ? 4 * (step + startError + Number.MIN_VALUE) / (1 - lambda) : 0;
  }
  return spent;
}

/**
 * Perturbation with BLA skipping and an interior proof.
 *
 * Interior pixels never escape, so without a shortcut they always run the
 * whole iteration budget. When the orbit returns close to its earlier
 * near-zero point after P iterations, the next P iterations are run without
 * BLA while tracking a radius r_k that bounds the image of the disk
 * D(z_start, r_0): |f(w) - f(z_k)| <= r_k (2|z_k| + r_k), plus a rounding
 * bound for every operation. If the image of the disk after P steps lies
 * inside the disk, f^P maps it into itself and the orbit can never escape.
 * Escaping pixels are unaffected (the check can only ever return INTERIOR),
 * and attempts are capped so they never more than double a pixel's work.
 */
function perturbNative(reference: Reference, dcRe: number, dcIm: number, limit: number, fallback: () => number, stats: SampleStats, pixel: number): number {
  const real = reference.real, imag = reference.imag, first = reference.firstRadiusSquared, glitch = reference.glitch;
  const end = real.length - 1;
  // zr, zi always hold Z_m; deltaSquared holds |δ|² for the current δ.
  let dr = 0, di = 0, m = 0, n = 0, zr = real[0], zi = imag[0], deltaSquared = 0;
  // dz/dc times the pixel size; unaffected by rebasing (z itself is unchanged). A BLA block maps it as δ: A z' + B pixel.
  let er = 0, ei = 0;
  // Interior proof state: the base is the smallest |z| since the last reset.
  // Above `far`, |z|² is certainly outside the band around |base|²: nothing to track.
  let baseRe = 0, baseIm = 0, baseSquared = Infinity, far = Infinity, baseN = 0, reset = 64, collapsedBase = false, retry = 0;
  // Proof state; ra..rd bound the disk images for four starting radii (radius0 x 1, 2^8, 2^16, 2^24).
  let verify = 0, spent = 0, steps = 0, startRe = 0, startIm = 0, startError = 0, radius0 = 0;
  let ra = 0, rb = 0, rc = 0, rd = 0, newtonRetry = 0, newtonFails = 0;
  const dcError = ROUNDING * Math.hypot(dcRe, dcIm);
  while (n < limit) {
    steps++;
    // Level 0 has the largest radius at m; >= also rejects squared deltas that underflow to 0.
    const quick = first[m];
    const level = verify || !(quick >= 1e-280 ? deltaSquared < quick : quick > 0)
      ? -1 : lookupNative(reference, m, dr, di, limit - n);
    const skipped = level >= 0;
    if (skipped) {
      const table = reference.native[level], o = ((m - 1) >> level) * NATIVE_FIELDS, length = 1 << level;
      const ar = table[o], ai = table[o + 1], br = table[o + 2], bi = table[o + 3];
      const nextEr = ar * er - ai * ei + br * pixel;
      ei = ar * ei + ai * er + bi * pixel; er = nextEr;
      const nextRe = ar * dr - ai * di + br * dcRe - bi * dcIm;
      di = ar * di + ai * dr + br * dcIm + bi * dcRe;
      dr = nextRe;
      m += length; n += length; stats.skipped += length - 1;
    } else {
      if (verify) {
        const reference = Math.hypot(zr, zi), delta = Math.hypot(dr, di);
        const twice = 2 * Math.hypot(zr + dr, zi + di), rounding = ROUNDING * (4 * reference * delta + delta * delta) + dcError;
        ra = ra * (twice + ra) + rounding; rb = rb * (twice + rb) + rounding;
        rc = rc * (twice + rc) + rounding; rd = rd * (twice + rd) + rounding;
      }
      const tr = zr + dr, ti = zi + di, nextEr = 2 * (tr * er - ti * ei) + pixel;
      ei = 2 * (tr * ei + ti * er); er = nextEr;
      const nextRe = 2 * (zr * dr - zi * di) + dr * dr - di * di + dcRe;
      di = 2 * (zr * di + zi * dr + dr * di) + dcIm;
      dr = nextRe;
      m++; n++;
    }
    zr = real[m]; zi = imag[m];
    const totalRe = zr + dr, totalIm = zi + di;
    const squared = totalRe * totalRe + totalIm * totalIm;
    if (!(squared <= 256)) {
      if (!Number.isFinite(squared)) return fallback();
      distance = escapeDistance(squared, er, ei);
      return smooth(n, 0.5 * Math.log2(squared));
    }
    deltaSquared = dr * dr + di * di;
    let rebase: boolean;
    if (squared >= 1e-280) {
      if (squared < glitch[m]) return fallback();
      rebase = squared < deltaSquared;
    } else {
      const radius = Math.hypot(totalRe, totalIm);
      if (radius < Math.hypot(zr, zi) * 1e-7) return fallback();
      rebase = radius < Math.hypot(dr, di);
    }
    if (verify) {
      // Representing z as Z + δ rounds once more; rebasing makes that the new state.
      const error = ROUNDING * (Math.hypot(zr, zi) + Math.hypot(dr, di));
      if (--verify === 0) {
        const distance = Math.hypot(totalRe - startRe, totalIm - startIm) + startError + error;
        if (distance + ra <= radius0 || distance + rb <= radius0 * 2 ** 8
          || distance + rc <= radius0 * 2 ** 16 || distance + rd <= radius0 * 2 ** 24) return INTERIOR;
        // Failed: relearn the base from scratch, and back off so orbits that
        // linger near a repelling cycle cannot keep switching BLA off.
        baseSquared = far = Infinity; collapsedBase = false; retry = 2 * n;
      } else if (rebase) { ra += error; rb += error; rc += error; rd += error; }
    } else if (!skipped && squared >= 1e-280 && (squared <= far || n >= reset)) {
      // Returns and collapses happen near z = 0, where BLA cannot apply: track
      // single steps only. Any return attractingCycle tries needs |z|² within
      // 2^-2 of |base|², so most steps stop at the `far` test above. A rough
      // return first tries attractingCycle; the in-loop proof starts on a
      // close return (within 2^-10), or on a second consecutive collapse
      // of |z| far below the base (super-attracting cycles shrink faster than
      // any fixed gap; two collapses in a row measure a true period). Proof
      // steps run without BLA, so they are capped by the steps executed.
      const relative = squared - baseSquared;
      const near = relative < TRAP_BAND * baseSquared && relative > -TRAP_BAND * baseSquared;
      const collapse = !near && squared < TRAP_RETURN_SQUARED * baseSquared;
      let start = false, distanceSquared = 0;
      const period = n - baseN;
      if (relative < NEWTON_BAND * baseSquared && relative > -NEWTON_BAND * baseSquared && n >= newtonRetry
        && n >= PROOF_START && period > 2 && spent + NEWTON_COST * period <= steps) {
        const ex = totalRe - baseRe, ey = totalIm - baseIm;
        if (ex * ex + ey * ey < NEWTON_RETURN_SQUARED * baseSquared) {
          const used = attractingCycle(reference, m, dr, di, dcRe, dcIm, period, dcError);
          if (used < 0) return INTERIOR;
          spent += used; newtonRetry = n + 4 * period * 2 ** ++newtonFails;
        }
      }
      if ((near || (collapse && collapsedBase)) && n >= retry && n >= PROOF_START && n - baseN > 2 && spent + n - baseN <= steps) {
        const ex = totalRe - baseRe, ey = totalIm - baseIm;
        distanceSquared = ex * ex + ey * ey;
        start = !near || distanceSquared < TRAP_RETURN_SQUARED * baseSquared;
      }
      if (start) {
        verify = n - baseN; spent += verify;
        startRe = totalRe; startIm = totalIm;
        startError = ROUNDING * (Math.hypot(zr, zi) + Math.hypot(dr, di));
        radius0 = 8 * (Math.sqrt(distanceSquared) + startError);
        ra = radius0; rb = radius0 * 2 ** 8; rc = radius0 * 2 ** 16; rd = radius0 * 2 ** 24;
      } else if (relative < 0 || n >= reset) {
        // Forget the base periodically, so a transient close pass cannot hide the cycle.
        if (n >= reset) reset *= 2;
        collapsedBase = collapse;
        baseRe = totalRe; baseIm = totalIm; baseSquared = squared; baseN = n;
        // Strictly beyond both bands even after rounding.
        far = squared * (1 + 2 * NEWTON_BAND);
      }
    }
    if (rebase || m === end) {
      dr = totalRe; di = totalIm; m = 0; zr = real[0]; zi = imag[0];
      deltaSquared = squared;
    }
  }
  stats.unresolved++;
  return INTERIOR;
}

/** log2(2^a + 2^b) without overflow or underflow. */
function logAdd(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return Math.max(a, b) + Math.log2(1 + 2 ** -Math.abs(a - b));
}
const LOG_ROUNDING = Math.log2(ROUNDING);
const negate = (a: Extended): Extended => ({ re: -a.re, im: -a.im, exp: a.exp });

/**
 * Extended-exponent perturbation, with the same interior proof as
 * perturbNative; radii are tracked as log2 so they cannot underflow.
 */
function perturbExtended(reference: Reference, dc: Extended, limit: number, fallback: () => number, stats: SampleStats, logPixel: number): number {
  const orbit = reference.orbit!;
  const logDc = logMagnitude(dc);
  let delta = ZERO, m = 0, n = 0;
  // z' (dz/dc times the pixel size) as (er, ei) 2^eExp, with lift = pixel / 2^eExp; zr, zi hold z itself (|z| <= 16).
  const pixelExponent = Math.floor(logPixel), pixel = extended(2 ** (logPixel - pixelExponent), 0, pixelExponent);
  let er = 0, ei = 0, eExp = pixel.exp, lift = pixel.re, zr = 0, zi = 0;
  let base: Extended | undefined, baseLog = Infinity, baseN = 0, reset = 64, collapsedBase = false, retry = 0;
  let verify = 0, spent = 0, steps = 0, start = ZERO, startError = -Infinity, logRadius0 = -Infinity;
  const logRadii = [-Infinity, -Infinity, -Infinity, -Infinity];
  while (n < limit) {
    steps++;
    const block = verify ? undefined : lookupExtended(reference, m, logMagnitude(delta), limit - n);
    const skipped = block !== undefined;
    if (block) {
      const derivative = linear(block.a, { re: er, im: ei, exp: eExp }, block.b, pixel);
      er = derivative.re; ei = derivative.im; eExp = derivative.exp; lift = 2 ** (logPixel - eExp);
      delta = linear(block.a, delta, block.b, dc);
      m += block.length; n += block.length; stats.skipped += block.length - 1;
    } else {
      if (verify) {
        const logZ = logMagnitude(add(orbit[m], delta)), logReference = logMagnitude(orbit[m]), logDelta = logMagnitude(delta);
        const rounding = LOG_ROUNDING + logAdd(logAdd(2 + logReference + logDelta, 2 * logDelta), logDc);
        for (let i = 0; i < 4; i++) logRadii[i] = logAdd(logRadii[i] + logAdd(1 + logZ, logRadii[i]), rounding);
      }
      const nextEr = 2 * (zr * er - zi * ei) + lift;
      ei = 2 * (zr * ei + zi * er); er = nextEr;
      if (Math.abs(er) + Math.abs(ei) > 2 ** 256) { er *= 2 ** -256; ei *= 2 ** -256; lift *= 2 ** -256; eExp += 256; }
      delta = perturbStep(orbit[m], delta, dc);
      m++; n++;
    }
    const z = orbit[m];
    const total = add(z, delta);
    const logTotal = logMagnitude(total);
    if (logTotal > 4) {
      distance = 2 ** (logTotal - Math.log2(Math.hypot(er, ei)) - eExp) * logTotal * Math.LN2;
      return smooth(n, logTotal);
    }
    const unit = 2 ** total.exp;
    zr = total.re * unit; zi = total.im * unit;
    if (logTotal < logMagnitude(z) - 24 || Number.isNaN(logTotal)) return fallback();
    const rebase = logTotal < logMagnitude(delta) || m === orbit.length - 1;
    if (verify) {
      const error = LOG_ROUNDING + logAdd(logMagnitude(z), logMagnitude(delta));
      if (--verify === 0) {
        const distance = logAdd(logMagnitude(add(total, negate(start))), logAdd(startError, error));
        if (logRadii.some((logRadius, i) => logAdd(distance, logRadius) <= logRadius0 + 8 * i)) return INTERIOR;
        base = undefined; baseLog = Infinity; collapsedBase = false; retry = 2 * n;
      } else if (rebase) for (let i = 0; i < 4; i++) logRadii[i] = logAdd(logRadii[i], error);
    } else if (skipped) {
      // Returns and collapses happen near z = 0, where BLA cannot apply: track single steps only.
    } else if (base) {
      // A return within 2^-10 needs |z| within ~2^-10 of |base|; test that and
      // the cheap eligibility conditions before subtracting extended values.
      const period = n - baseN, collapse = logTotal < baseLog - 10;
      const eligible = n >= retry && n >= PROOF_START && period > 2 && spent + period <= steps;
      const near = eligible && Math.abs(logTotal - baseLog) < 0.002;
      const logDistance = near ? logMagnitude(add(total, negate(base))) : Infinity;
      if (eligible && (logDistance < baseLog - 10 || (collapse && collapsedBase))) {
        verify = period; spent += period; start = total;
        startError = LOG_ROUNDING + logAdd(logMagnitude(z), logMagnitude(delta));
        logRadius0 = 3 + logAdd(logDistance, startError);
        for (let i = 0; i < 4; i++) logRadii[i] = logRadius0 + 8 * i;
      } else if (logTotal < baseLog || n >= reset) {
        if (n >= reset) reset *= 2;
        collapsedBase = collapse;
        base = total; baseLog = logTotal; baseN = n;
      }
    } else { base = total; baseLog = logTotal; baseN = n; }
    if (rebase) { delta = total; m = 0; }
  }
  stats.unresolved++;
  return INTERIOR;
}

export interface Sampler {
  sample(x: number, y: number): number;
  /** Optional faster path for a row of samples sharing one y (CSS offsets from the centre), with distance estimates. */
  row?(xs: Float64Array, count: number, y: number, out: Float64Array, distances: Float64Array): void;
  stats: SampleStats;
}

export interface ReferenceEntry extends ReferenceSpec { reference: Reference }

export interface ReferenceCache { entry?: ReferenceEntry }

/** Supplies a shared reference chosen by the main thread instead of building one locally. */
export type ReferenceSource = () => Promise<ReferenceEntry>;

export async function createSampler(view: View, cssWidth: number, cssHeight: number, limit: number, checkpoint: Checkpoint,
  cache: ReferenceCache = {}, source?: ReferenceSource): Promise<Sampler> {
  const stats: SampleStats = { fallbacks: 0, skipped: 0, unresolved: 0 };
  if (view.logScale > DEEP_LOG_SCALE) {
    const cr = fixedToNumber(view.re, view.bits), ci = fixedToNumber(view.im, view.bits);
    const scale = 2 ** view.logScale;
    let row = new Float64Array(0);
    return { stats,
      sample(x, y) { distance = NaN; return directDouble(cr + x * scale, ci - y * scale, limit, scale); },
      row(xs, count, y, out, distances) {
        if (row.length < count) row = new Float64Array(count);
        for (let i = 0; i < count; i++) row[i] = cr + xs[i] * scale;
        stats.unresolved += directRow(row, ci - y * scale, count, limit, out, distances, scale);
      } };
  }
  const logRadius = viewLogRadius(view, cssWidth, cssHeight);
  const interior = interiorStatus(view, logRadius);
  if (interior === 'inside') return { stats, sample: () => { distance = NaN; return INTERIOR; } };
  const exactInterior = interior === 'near';

  const native = view.logScale > EXTENDED_LOG_SCALE;
  let entry = source ? await source() : cache.entry;
  let offset = entry && referenceOffset(entry, view, logRadius, limit);
  // A shallower reference may lack the extended tables a deeper view needs.
  if (!entry || !offset || (!native && !entry.reference.levels)) {
    const spec = referenceSpec(view, cssWidth, cssHeight, limit);
    entry = { ...spec, reference: await buildReference(view, limit, spec.logRadius, checkpoint) };
    cache.entry = entry;
    offset = ZERO;
  }
  const reference = entry.reference;
  const exponent = Math.floor(view.logScale);
  const mantissa = 2 ** (view.logScale - exponent);
  const scale = 2 ** view.logScale;
  const offsetRe = offset.re * 2 ** offset.exp, offsetIm = offset.im * 2 ** offset.exp;
  return { stats, sample(x, y) {
    // Fixed-point is only used per pixel for exact interior tests or detected glitches.
    distance = NaN;
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
      ? perturbNative(reference, offsetRe + x * scale, offsetIm - y * scale, limit, fallback, stats, scale)
      : perturbExtended(reference, add(offset, extended(x * mantissa, -y * mantissa, exponent)), limit, fallback, stats, view.logScale);
  } };
}

export { color, colorWord, lapsOf, LAPS_PER_E_FOLD, shadedWord } from './palette.ts';
